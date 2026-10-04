import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'
const npmCommand = isWindows ? 'npm.cmd' : 'npm'

const tasks = [
  ['api', ['run', 'dev:api']],
  ['renderer', ['run', 'dev:renderer']],
  ['electron', ['run', 'dev:electron']]
]

const children = []
let shuttingDown = false

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      child.kill(signal)
    }
  }
}

for (const [label, args] of tasks) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: isWindows,
    windowsHide: true
  })

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `exit code ${code}`
    console.log(`[dev:${label}] stopped (${reason})`)

    if (!shuttingDown && code !== 0) {
      stopAll()
      process.exit(code ?? 1)
    }
  })

  child.on('error', (error) => {
    console.error(`[dev:${label}] failed: ${error.message}`)
    stopAll()
    process.exit(1)
  })

  children.push(child)
}

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))

for (const child of children) {
  child.on('exit', () => {
    if (children.every((entry) => entry.exitCode !== null || entry.signalCode !== null)) {
      process.exit(0)
    }
  })
}
