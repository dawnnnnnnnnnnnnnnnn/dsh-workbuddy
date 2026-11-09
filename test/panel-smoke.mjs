// 面板独立预览：不经过 dsh，直接把 panel.html + 全部接口挂到一个临时端口
//   node test/panel-smoke.mjs [port]
import http from 'node:http'
import { createRuntime } from '../lib/runtime.js'
import { installRoutes } from '../lib/server.js'

const port = Number(process.argv[2] || 0)
const routes = new Map()
const fakeHost = {
  webServer: {
    register(spec) {
      routes.set(spec.path, spec.handler)
      return () => routes.delete(spec.path)
    },
  },
}

const runtime = createRuntime({})
installRoutes(fakeHost, runtime, {})

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (!handler) {
    res.writeHead(404).end('no route: ' + path)
    return
  }
  Promise.resolve(handler(req, res)).catch((e) => {
    res.writeHead(500).end(String(e))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`panel preview: http://127.0.0.1:${server.address().port}/dsh-workbuddy/panel?scheme=dark`)
  console.log(`routes: ${[...routes.keys()].join(', ')}`)
})
