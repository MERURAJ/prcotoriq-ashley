import { createServer } from 'node:http'
import { randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_QUESTIONS } from './default-questions.mjs'

const scrypt = promisify(scryptCallback)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDirectory = resolve(process.env.DATA_DIR || resolve(root, '..', 'proctoriq-data'))
const dataRelativeToRoot = relative(root, dataDirectory)
if (dataRelativeToRoot === '' || (!isAbsolute(dataRelativeToRoot) && dataRelativeToRoot !== '..' && !dataRelativeToRoot.startsWith(`..${sep}`))) {
  throw new Error('DATA_DIR must be outside the frontend project directory.')
}
const dataFile = resolve(dataDirectory, 'proctoriq.json')
const PORT = Number(process.env.PORT || 3001)
const SESSION_MS = 8 * 60 * 60 * 1000
const DURATION_MS = 10 * 60 * 1000
const EVENT_TYPES = new Set(['tab_switch', 'fullscreen_exit', 'no_face', 'multiple_faces', 'camera_unavailable', 'detector_unavailable'])
const MIME_TYPES = { '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const sessions = new Map()
const loginFailures = new Map()
const codeRuns = new Map()
let wandboxQueue = Promise.resolve()
let writeQueue = Promise.resolve()

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
const derivePassword = async (password, salt) => Buffer.from(await scrypt(password, salt, 64))
const safeEqual = (left, right) => left.length === right.length && timingSafeEqual(left, right)

const saveDatabase = () => {
  const serialized = JSON.stringify(database, null, 2)
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const temp = `${dataFile}.${randomToken(8)}.tmp`
    await writeFile(temp, serialized, { mode: 0o600 })
    await rename(temp, dataFile)
  })
  return writeQueue
}

await mkdir(dataDirectory, { recursive: true })
let database
try {
  database = JSON.parse(await readFile(dataFile, 'utf8'))
  if (!database || typeof database !== 'object' || !database.admin || !Array.isArray(database.questions) || !Array.isArray(database.results) || !database.attempts) {
    throw new Error(`Invalid database format in ${dataFile}`)
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  const username = (process.env.ADMIN_USERNAME || 'admin').trim()
  const configuredPassword = process.env.ADMIN_PASSWORD
  const password = configuredPassword || randomToken(24)
  if (!username || username.length > 80) throw new Error('ADMIN_USERNAME must contain 1 to 80 characters')
  if (configuredPassword && (configuredPassword.length < 12 || configuredPassword.length > 256)) throw new Error('ADMIN_PASSWORD must contain 12 to 256 characters')
  const salt = randomBytes(16)
  database = {
    admin: { username, salt: salt.toString('hex'), passwordHash: (await derivePassword(password, salt)).toString('hex') },
    questions: DEFAULT_QUESTIONS,
    attempts: {},
    results: []
  }
  await saveDatabase()
  if (!configuredPassword) {
    console.log('First-run administrator credentials')
    console.log(`Username: ${username}`)
    console.log(`Password: ${password}`)
    console.log('Save this password now. It is stored only as a hash; set ADMIN_PASSWORD before first startup to choose your own.')
  } else {
    console.log(`Administrator account "${username}" initialized from environment configuration.`)
  }
}

let removedLegacyStarterCode = false
const removeLegacyStarterCode = question => {
  if (question?.kind !== 'coding' || !Object.prototype.hasOwnProperty.call(question, 'starterCode')) return
  delete question.starterCode
  removedLegacyStarterCode = true
}
for (const question of database.questions) removeLegacyStarterCode(question)
for (const attempt of Object.values(database.attempts)) {
  for (const question of attempt.questionSnapshot || []) removeLegacyStarterCode(question)
}
if (removedLegacyStarterCode) await saveDatabase()

const json = (response, status, payload, headers = {}) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers
  })
  response.end(JSON.stringify(payload))
}

const readBody = async request => {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body is too large.')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
    return value
  } catch { throw new HttpError(400, 'Request body must be a JSON object.') }
}

const requireJsonHeader = request => {
  if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json.')
  }
}

const parseQuestions = input => {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new HttpError(400, 'Provide between 1 and 100 questions.')
  const ids = new Set()
  return input.map((question, index) => {
    if (!question || typeof question !== 'object') throw new HttpError(400, `Question ${index + 1} is invalid.`)
    const { id, category, text } = question
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || ids.has(id)) throw new HttpError(400, `Question ${index + 1} has an invalid or duplicate ID.`)
    if (typeof category !== 'string' || !category.trim() || category.length > 100) throw new HttpError(400, `Question ${index + 1} needs a category of at most 100 characters.`)
    const kind = question.kind || 'mcq'
    if (!['mcq', 'coding'].includes(kind)) throw new HttpError(400, `Question ${index + 1} has an invalid type.`)
    if (typeof text !== 'string' || !text.trim() || text.length > (kind === 'coding' ? 20000 : 2000)) throw new HttpError(400, `Question ${index + 1} needs valid question text.`)
    if (kind === 'coding') {
      const validatePairs = (values, label, outputKey) => {
        if (!Array.isArray(values) || values.length > 20 || (label === 'test cases' && values.length < 1)) throw new HttpError(400, `Question ${index + 1} needs between ${label === 'test cases' ? '1 and ' : '0 and '}20 ${label}.`)
        return values.map((value, pairIndex) => {
          let input
          try {
            input = typeof value?.input === 'string' ? value.input : JSON.stringify(value?.input)
          } catch {
            throw new HttpError(400, `Question ${index + 1} ${label} entry ${pairIndex + 1} has invalid input.`)
          }
          const output = value?.[outputKey]
          if (typeof input !== 'string' || input.length > 10000 || typeof output !== 'string' || output.length > 10000) {
            throw new HttpError(400, `Question ${index + 1} ${label} entry ${pairIndex + 1} is invalid.`)
          }
          return { input, [outputKey]: output }
        })
      }
      if (typeof question.constraints !== 'string' || question.constraints.length > 10000) throw new HttpError(400, `Question ${index + 1} constraints are invalid.`)
      ids.add(id)
      return {
        id, category: category.trim(), text: text.trim(), kind, options: [], constraints: question.constraints,
        examples: validatePairs(question.examples || [], 'examples', 'output'),
        testCases: validatePairs(question.testCases, 'test cases', 'expectedOutput')
      }
    }
    const { options, answer } = question
    if (!Array.isArray(options) || options.length < 2 || options.length > 8 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500)) {
      throw new HttpError(400, `Question ${index + 1} must have 2 to 8 non-empty options of at most 500 characters.`)
    }
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw new HttpError(400, `Question ${index + 1} must have a correct option selected.`)
    ids.add(id)
    return { id, category: category.trim(), text: text.trim(), kind: 'mcq', options: options.map(option => option.trim()), answer }
  })
}

const publicQuestion = question => question.kind === 'coding'
  ? (({ id, category, text, kind, options, examples, constraints }) => ({ id, category, text, kind, options, examples, constraints }))(question)
  : (({ id, category, text, kind, options }) => ({ id, category, text, kind, options }))(question)

const normalizeOutput = output => output.replace(/\r\n/g, '\n').trimEnd()

const stableJson = value => {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]))
  }
  return value
}

const outputsMatch = (actual, expected) => {
  const normalizedActual = normalizeOutput(actual)
  const normalizedExpected = normalizeOutput(expected)
  try {
    return JSON.stringify(stableJson(JSON.parse(normalizedActual))) ===
      JSON.stringify(stableJson(JSON.parse(normalizedExpected)))
  } catch {
    return normalizedActual === normalizedExpected
  }
}

const safeProviderError = async response => {
  let message = ''
  try {
    const body = await response.json()
    if (typeof body.message === 'string') message = body.message
    else if (typeof body.error === 'string') message = body.error
    else if (typeof body.detail === 'string') message = body.detail
  } catch {
    // Providers may return HTML or an empty body for gateway errors.
  }
  if (!message) return ''
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 400)
}

const runInWandbox = async ({ source, language, stdin }) => {
  const compilers = { python: 'cpython-3.10.15', cpp: 'gcc-13.2.0', java: 'openjdk-jdk-22+36' }
  const execute = async () => {
    let result
    for (let retry = 0; retry <= 1; retry++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 75000)
      let response
      try {
        response = await fetch('https://wandbox.org/api/compile.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ compiler: compilers[language], code: source, stdin }),
          signal: controller.signal
        })
      } catch (error) {
        if (error.name === 'AbortError') throw new HttpError(504, 'Code execution timed out while waiting for Wandbox.')
        throw new HttpError(502, 'Could not connect to the Wandbox code execution service.')
      } finally {
        clearTimeout(timer)
      }
      if (response.status === 429) {
        const providerMessage = await safeProviderError(response)
        if (retry < 1) {
          const retryAfter = Number(response.headers.get('retry-after'))
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(2000, retryAfter * 1000)
            : 750
          await new Promise(resolve => setTimeout(resolve, backoff))
          continue
        }
        const detail = providerMessage ? ` Provider response: ${providerMessage}` : ''
        throw new HttpError(503, `Wandbox is temporarily rate-limiting code submissions.${detail} Your code is saved; try again shortly.`)
      }
      if (!response.ok) {
        const providerMessage = await safeProviderError(response)
        const detail = providerMessage ? ` Provider response: ${providerMessage}` : ''
        throw new HttpError(502, `Wandbox code execution service returned HTTP ${response.status}.${detail}`)
      }
      result = await response.json()
      const providerDiagnostics = [
        result.compiler_error, result.compiler_output, result.compiler_message,
        result.program_error, result.program_message, result.program_output
      ]
        .filter(value => typeof value === 'string').join('\n')
      if (/OCI runtime error|crun.*clone|resource temporarily unavailable|failed to create.*container|container runtime|temporarily unavailable/i.test(providerDiagnostics)) {
        if (retry === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          continue
        }
        throw new HttpError(503, 'Wandbox could not start a compiler container after retrying. This is an execution-service issue, not a failed test. No test cases were graded; your code is saved. Please try again shortly.')
      }
      break
    }
    if (!result) throw new HttpError(503, 'Wandbox is temporarily unavailable. Your code is saved; try again shortly.')
    const exitCode = result.status === '' || result.status === null || result.status === undefined
      ? null
      : Number.isInteger(Number(result.status)) ? Number(result.status) : null
    const compileOutput = [result.compiler_error, result.compiler_output].filter(value => typeof value === 'string' && value).join('\n')
    const stderr = typeof result.program_error === 'string' && result.program_error
      ? result.program_error
      : typeof result.program_message === 'string' && exitCode !== 0 ? result.program_message : null
    const accepted = exitCode === 0 && !result.signal
    return {
      status: accepted ? 'Accepted' : compileOutput ? 'Compilation Error' : result.signal ? `Terminated (${result.signal})` : `Runtime Error${exitCode === null ? '' : ` (exit code ${exitCode})`}`,
      statusId: accepted ? 3 : 6,
      stdout: typeof result.program_output === 'string' ? result.program_output.slice(0, 20000) : null,
      stderr: typeof stderr === 'string' ? stderr.slice(0, 10000) : null,
      compileOutput: compileOutput ? compileOutput.slice(0, 10000) : null,
      exitCode
    }
  }

  const queued = wandboxQueue.then(execute, execute)
  wandboxQueue = queued.then(() => undefined, () => undefined)
  return queued
}

const enforceCodeRunLimit = attemptId => {
  const now = Date.now()
  const recent = (codeRuns.get(attemptId) || []).filter(time => now - time < 60000)
  if (recent.length >= 10) throw new HttpError(429, 'Too many code executions. Wait a minute before running more code.')
  recent.push(now)
  codeRuns.set(attemptId, recent)
}
const shuffle = values => {
  const items = [...values]
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

const parseEvents = events => {
  if (!Array.isArray(events) || events.length > 1000) throw new HttpError(400, 'Monitoring event data is invalid or too large.')
  return events.map(event => {
    if (!event || !EVENT_TYPES.has(event.type) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || typeof event.detail !== 'string' || event.detail.length > 500) {
      throw new HttpError(400, 'A monitoring event is invalid.')
    }
    return { type: event.type, at: event.at, detail: event.detail }
  })
}

const cookieValue = (request, key) => {
  const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${key}=`))
  return cookie ? decodeURIComponent(cookie.slice(key.length + 1)) : ''
}
const sessionFor = request => {
  const token = cookieValue(request, 'proctoriq_admin')
  const session = sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token)
    return null
  }
  return { token, session }
}
const requireAdmin = request => {
  const found = sessionFor(request)
  if (!found) throw new HttpError(401, 'Administrator sign-in is required.')
  return found
}
const requireFetchHeader = request => {
  if (request.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'This request is not allowed.')
}
const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : ''

const sendStatic = async (request, response, pathname) => {
  const decoded = decodeURIComponent(pathname)
  const dist = resolve(root, 'dist')
  let file = resolve(dist, `.${decoded === '/' ? '/index.html' : decoded}`)
  if (!file.startsWith(`${dist}${sep}`) && file !== resolve(dist, 'index.html')) throw new HttpError(400, 'Invalid path.')
  try {
    const contents = await readFile(file)
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(contents)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (extname(decoded)) throw new HttpError(404, 'Not found.')
    const contents = await readFile(resolve(dist, 'index.html')).catch(() => { throw new HttpError(503, 'Production app has not been built. Run npm run build first.') })
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    response.end(contents)
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    const { pathname } = url

    if (request.method === 'GET' && pathname === '/api/code/status') {
      return json(response, 200, {
        provider: 'Wandbox',
        configured: true,
        authenticationRequired: false
      })
    }

    if (request.method === 'GET' && pathname === '/api/admin/session') {
      const found = sessionFor(request)
      return json(response, 200, { authenticated: Boolean(found), username: found ? database.admin.username : null })
    }

    if (request.method === 'POST' && pathname === '/api/admin/login') {
      requireJsonHeader(request)
      requireFetchHeader(request)
      const address = request.socket.remoteAddress || 'unknown'
      const failure = loginFailures.get(address)
      if (failure && failure.blockedUntil > Date.now()) throw new HttpError(429, 'Too many sign-in attempts. Try again later.')
      const body = await readBody(request)
      const username = typeof body.username === 'string' ? body.username : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length > 256) throw new HttpError(400, 'Password is too long.')
      const salt = Buffer.from(database.admin.salt, 'hex')
      const hash = await derivePassword(password, salt)
      const valid = username === database.admin.username && safeEqual(hash, Buffer.from(database.admin.passwordHash, 'hex'))
      if (!valid) {
        const failures = failure?.count ? failure.count + 1 : 1
        loginFailures.set(address, { count: failures, blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0 })
        throw new HttpError(401, 'Username or password is incorrect.')
      }
      loginFailures.delete(address)
      const token = randomToken()
      sessions.set(token, { expiresAt: Date.now() + SESSION_MS })
      return json(response, 200, { authenticated: true, username }, {
        'Set-Cookie': `proctoriq_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookie}`
      })
    }

    if (request.method === 'POST' && pathname === '/api/admin/logout') {
      requireFetchHeader(request)
      const found = sessionFor(request)
      if (found) sessions.delete(found.token)
      return json(response, 200, { authenticated: false }, {
        'Set-Cookie': `proctoriq_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`
      })
    }

    if (request.method === 'GET' && pathname === '/api/admin/questions') {
      requireAdmin(request)
      return json(response, 200, { questions: database.questions })
    }

    if (request.method === 'PUT' && pathname === '/api/admin/questions') {
      requireAdmin(request)
      requireJsonHeader(request)
      requireFetchHeader(request)
      const body = await readBody(request)
      database.questions = parseQuestions(body.questions)
      await saveDatabase()
      return json(response, 200, { questions: database.questions })
    }

    if (request.method === 'GET' && pathname === '/api/admin/results') {
      requireAdmin(request)
      return json(response, 200, { results: database.results })
    }

    if (request.method === 'DELETE' && pathname === '/api/admin/results') {
      requireAdmin(request)
      requireJsonHeader(request)
      requireFetchHeader(request)
      database.results = []
      for (const [id, attempt] of Object.entries(database.attempts)) {
        if (attempt.completed) delete database.attempts[id]
      }
      await saveDatabase()
      return json(response, 200, { results: [] })
    }

    if (request.method === 'POST' && pathname === '/api/attempts') {
      requireJsonHeader(request)
      const body = await readBody(request)
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) throw new HttpError(400, 'Enter a name of at most 80 characters.')
      const id = randomUUID()
      const questionBank = parseQuestions(database.questions)
      const questions = [
        ...shuffle(questionBank.filter(question => question.kind !== 'coding')),
        ...shuffle(questionBank.filter(question => question.kind === 'coding'))
      ]
      const attempt = {
        id,
        name: body.name.trim(),
        startedAt: Date.now(),
        questionSnapshot: questions,
        completed: false
      }
      database.attempts[id] = attempt
      await saveDatabase()
      return json(response, 201, {
        id,
        name: attempt.name,
        startedAt: attempt.startedAt,
        questions: questions.map(publicQuestion)
      })
    }

    const codeMatch = pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/code\/(save|run|submit)$/i)
    if (request.method === 'POST' && codeMatch) {
      requireJsonHeader(request)
      const body = await readBody(request)
      const attempt = database.attempts[codeMatch[1]]
      if (!attempt) throw new HttpError(404, 'Assessment attempt not found.')
      if (attempt.completed) throw new HttpError(409, 'This assessment has already been submitted.')
      if (Date.now() >= attempt.startedAt + DURATION_MS) throw new HttpError(409, 'The assessment time has expired.')
      const question = attempt.questionSnapshot.find(item => item.id === body.questionId && item.kind === 'coding')
      if (!question) throw new HttpError(400, 'Coding question not found in this attempt.')
      if (!['python', 'cpp', 'java'].includes(body.language)) throw new HttpError(400, 'Choose Python 3, C++17, or Java.')
      if (typeof body.source !== 'string' || !body.source.trim() || body.source.length > 50000) throw new HttpError(400, 'Code must contain 1 to 50,000 characters.')
      attempt.codeDrafts ||= {}
      attempt.codeDrafts[question.id] = {
        language: body.language,
        source: body.source,
        savedAt: new Date().toISOString()
      }
      await saveDatabase()
      if (codeMatch[2] === 'save') return json(response, 200, { saved: true })
      enforceCodeRunLimit(attempt.id)
      if (codeMatch[2] === 'run') {
        if (body.mode !== 'custom') {
          const examples = question.examples || []
          if (!examples.length) throw new HttpError(400, 'This question has no public sample cases. Add public examples in the question bank or use Run Custom Input.')
          const results = []
          for (let index = 0; index < examples.length; index += 4) {
            const batch = await Promise.all(examples.slice(index, index + 4).map(example =>
              runInWandbox({ source: body.source, language: body.language, stdin: example.input })
            ))
            results.push(...batch.map((result, offset) => {
              const expectedOutput = examples[index + offset].output
              const passed = result.statusId === 3 && result.exitCode === 0 &&
                outputsMatch(result.stdout || '', expectedOutput)
              return { index: index + offset, passed, expectedOutput, ...result }
            }))
          }
          return json(response, 200, {
            mode: 'examples',
            passed: results.filter(result => result.passed).length,
            total: results.length,
            results
          })
        }
        if (typeof body.stdin !== 'string' || body.stdin.length > 20000) throw new HttpError(400, 'Custom input must be 20,000 characters or fewer.')
        const result = await runInWandbox({ source: body.source, language: body.language, stdin: body.stdin })
        return json(response, 200, { result })
      }
      const testCases = question.testCases
      if (!Array.isArray(testCases) || testCases.length === 0) throw new HttpError(500, 'This coding question has no configured grading test cases.')
      const results = []
      for (let index = 0; index < testCases.length; index += 4) {
        const batch = await Promise.all(testCases.slice(index, index + 4).map(testCase =>
          runInWandbox({ source: body.source, language: body.language, stdin: testCase.input })
        ))
        results.push(...batch.map((result, offset) => {
          const testCase = testCases[index + offset]
          const passed = result.statusId === 3 && result.exitCode === 0 &&
            outputsMatch(result.stdout || '', testCase.expectedOutput)
          const { status, stdout, stderr, compileOutput, exitCode } = result
          return { index: index + offset, passed, status, stdout, stderr, compileOutput, exitCode }
        }))
      }
      const passed = results.filter(result => result.passed).length
      const submission = {
        language: body.language,
        source: body.source,
        score: passed / testCases.length,
        passed,
        total: testCases.length,
        submittedAt: new Date().toISOString()
      }
      attempt.codingSubmissions ||= {}
      attempt.codingSubmissions[question.id] = submission
      await saveDatabase()
      return json(response, 200, { passed, total: testCases.length, score: submission.score, results })
    }

    const submitMatch = pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/submit$/i)
    if (request.method === 'POST' && submitMatch) {
      requireJsonHeader(request)
      const body = await readBody(request)
      const attempt = database.attempts[submitMatch[1]]
      if (!attempt) throw new HttpError(404, 'Assessment attempt not found.')
      if (attempt.completed) throw new HttpError(409, 'This assessment has already been submitted.')
      const answers = body.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new HttpError(400, 'Answer data is invalid.')
      for (const [id, answer] of Object.entries(answers)) {
        const question = attempt.questionSnapshot.find(item => item.id === id)
        if (!question || !Number.isInteger(answer) || answer < 0 || answer >= question.options.length) throw new HttpError(400, 'An answer is invalid.')
      }
      const events = parseEvents(body.events)
      const mcqQuestions = attempt.questionSnapshot.filter(question => question.kind !== 'coding')
      const codingQuestions = attempt.questionSnapshot.filter(question => question.kind === 'coding')
      const mcqScore = mcqQuestions.filter(question => answers[question.id] === question.answer).length
      const codingScore = Object.values(attempt.codingSubmissions || {}).reduce((total, submission) => total + submission.score, 0)
      const codingTestScore = Object.values(attempt.codingSubmissions || {}).reduce((total, submission) => total + submission.passed, 0)
      const codingTestTotal = codingQuestions.reduce((total, question) => total + (question.testCases?.length || 0), 0)
      const score = mcqScore + codingScore
      const submittedAt = Date.now()
      const autoSubmitted = body.autoSubmitted === true || submittedAt >= attempt.startedAt + DURATION_MS
      const result = {
        id: attempt.id,
        name: attempt.name,
        startedAt: new Date(attempt.startedAt).toISOString(),
        submittedAt: new Date(submittedAt).toISOString(),
        score,
        total: attempt.questionSnapshot.length,
        mcqScore,
        mcqTotal: mcqQuestions.length,
        codingScore: codingTestScore,
        codingTotal: codingTestTotal,
        percentage: Math.round((score / attempt.questionSnapshot.length) * 100),
        tabSwitchCount: events.filter(event => event.type === 'tab_switch').length,
        fullscreenExitCount: events.filter(event => event.type === 'fullscreen_exit').length,
        webcamEventCount: events.filter(event => !['tab_switch', 'fullscreen_exit'].includes(event.type)).length,
        codingSubmissions: attempt.codingSubmissions || {},
        events,
        autoSubmitted
      }
      attempt.completed = true
      database.results.push(result)
      await saveDatabase()
      return json(response, 201, { id: result.id })
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.')
    if (process.env.NODE_ENV === 'production') return await sendStatic(request, response, pathname)
    throw new HttpError(404, 'Not found.')
  } catch (error) {
    if (error instanceof HttpError) return json(response, error.status, { error: error.message })
    console.error('Request failed:', error)
    return json(response, 500, { error: 'The server could not complete the request.' })
  }
})

server.listen(PORT, () => {
  console.log(`ProctorIQ API listening on http://localhost:${PORT}`)
  if (process.env.NODE_ENV === 'production') console.log('Production mode: serving the built application from dist/.')
})
