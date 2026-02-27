#!/usr/bin/env node
/**
 * demo.js — 一条命令体验 agent-control
 *
 * Usage:
 *   agent-control demo web     # 打开 FlowLab，跑 5 步 demo
 *   agent-control demo         # 默认 web
 */

const { execSync, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

const ROOT = __dirname
const args = process.argv.slice(2)
const platform = args[0] || 'web'

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m',
  dim: '\x1b[2m', bold: '\x1b[1m', yellow: '\x1b[33m',
}

function log(msg) { console.log(`${C.green}▸${C.reset} ${msg}`) }
function dim(msg) { console.log(`${C.dim}  ${msg}${C.reset}`) }
function step(n, msg) { console.log(`\n${C.cyan}[${n}/5]${C.reset} ${C.bold}${msg}${C.reset}`) }

if (platform !== 'web') {
  console.log(`${C.yellow}目前 demo 只支持 web 平台${C.reset}`)
  console.log(`用法: agent-control demo web`)
  process.exit(1)
}

async function runWebDemo() {
  const cli = path.join(ROOT, 'cli.js')
  const flowlab = path.join(ROOT, 'flowlab', 'index.html')

  if (!fs.existsSync(flowlab)) {
    console.error('FlowLab 页面不存在，请确认 agent-control 安装完整')
    process.exit(1)
  }

  console.log(`\n${C.bold}🎯 agent-control Web Demo${C.reset}`)
  console.log(`${C.dim}${'─'.repeat(40)}${C.reset}\n`)

  // Step 1: 检查环境
  step(1, '检查环境')
  const doctorR = spawnSync(process.execPath, [path.join(ROOT, 'doctor.js'), '-p', 'web'], { encoding: 'utf8' })
  if (doctorR.status !== 0) {
    console.log(doctorR.stdout)
    console.error('环境检查未通过，请先修复上述问题')
    process.exit(1)
  }
  log('环境 OK')

  // Step 2: 启动 Web daemon
  step(2, '启动 Web driver')
  const daemonPath = path.join(ROOT, 'web-driver', 'daemon.js')
  const pidFile = '/tmp/agent-control-web.json'

  // 检查是否已在运行
  let daemonRunning = false
  if (fs.existsSync(pidFile)) {
    try {
      const info = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
      const res = spawnSync('kill', ['-0', String(info.pid)])
      daemonRunning = res.status === 0
    } catch {}
  }

  if (!daemonRunning) {
    const daemon = require('child_process').spawn(process.execPath, [daemonPath], {
      detached: true, stdio: 'ignore',
    })
    daemon.unref()
    dim('等待 daemon 启动...')
    await sleep(2000)
  }
  log('Web driver 就绪 (port 3901)')

  // Step 3: 打开 FlowLab
  step(3, '打开 FlowLab 测试页面')
  const flowUrl = `file://${flowlab}`
  const r1 = cmd(cli, ['-p', 'web', 'open', flowUrl])
  if (!r1) { fail('打开页面失败'); return }
  await sleep(1500)
  log(`已打开 ${flowUrl}`)

  // Step 4: 截取快照
  step(4, '截取交互元素快照')
  const r2 = cmd(cli, ['-p', 'web', 'snapshot', '-e'])
  if (r2) {
    const lines = r2.split('\n').filter(l => l.trim())
    log(`发现 ${lines.length} 个交互元素`)
    lines.slice(0, 5).forEach(l => dim(l))
    if (lines.length > 5) dim(`... 还有 ${lines.length - 5} 个`)
  }

  // Step 5: 截图
  step(5, '截图保存')
  const ssPath = path.join(ROOT, 'runs', 'demo-screenshot.png')
  const r3 = cmd(cli, ['-p', 'web', 'screenshot', ssPath])
  if (r3 !== null) {
    log(`截图已保存: ${ssPath}`)
  }

  console.log(`\n${C.green}${C.bold}✅ Demo 完成！${C.reset}`)
  console.log(`\n${C.dim}接下来可以试试:`)
  console.log(`  agent-control -p web snapshot -e    # 查看页面元素`)
  console.log(`  agent-control -p web click @e1      # 点击元素`)
  console.log(`  agent-control -p web fill @e3 hello  # 填写输入框`)
  console.log(`  agent-control doctor                 # 检查所有平台${C.reset}\n`)
}

function cmd(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 })
  if (r.status !== 0) return null
  return (r.stdout || '').trim()
}

function fail(msg) { console.error(`${C.yellow}✗ ${msg}${C.reset}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

runWebDemo().catch(err => { console.error(err); process.exit(1) })

