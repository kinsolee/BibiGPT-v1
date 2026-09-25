#!/usr/bin/env node
/**
 * Minimal local mock of the Upstash Redis REST protocol used by BibiGPT-v1 in
 * local verification (no real Upstash account needed).
 *
 * Implements the command subset the app sends as JSON arrays to the base URL:
 *   ["set", key, value] ["get", key] ["del", key] ["keys", pattern]
 *   ["incr", key] ["expire", key, s] ["ttl", key] ["eval", script, n, key, arg]
 * Pipelines arrive as arrays of command arrays and are answered per-command.
 *
 * Usage: node scripts/mock-upstash.mjs [--port 3299]
 */

import { createServer } from 'node:http'

const port = Number(process.argv.find((a) => a === '--port') ? process.argv[process.argv.indexOf('--port') + 1] : 3299)
const store = new Map()
const counters = new Map()

function globToRegExp(pattern) {
  let regex = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      regex += '.*'
    } else if (char === '?') {
      regex += '.'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      regex += `\\${char}`
    } else {
      regex += char
    }
  }
  return new RegExp(`^${regex}$`)
}

function runCommand(command) {
  const [op, ...args] = command
  switch (op.toLowerCase()) {
    case 'ping':
      return 'PONG'
    case 'flushall':
    case 'flushdb':
      store.clear()
      counters.clear()
      return 'OK'
    case 'set':
      store.set(String(args[0]), args[1] === undefined ? null : String(args[1]))
      return 'OK'
    case 'get':
      return store.has(String(args[0])) ? store.get(String(args[0])) : null
    case 'del':
      return store.delete(String(args[0])) ? 1 : 0
    case 'keys': {
      const regex = globToRegExp(String(args[0]))
      return [...store.keys()].filter((key) => regex.test(key))
    }
    case 'incr': {
      const key = String(args[0])
      const next = (counters.get(key) || 0) + 1
      counters.set(key, next)
      return next
    }
    case 'expire':
      return 1
    case 'ttl':
      return store.has(String(args[0])) ? 3600 : -2
    case 'eval': {
      // Fixed-window approximation for @upstash/ratelimit: the scripts only
      // read the counter for the first key and return the new count.
      const keysStart = 3
      const key = String(command[keysStart])
      const next = (counters.get(key) || 0) + 1
      counters.set(key, next)
      return next
    }
    default:
      return null
  }
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    try {
      if (!raw) {
        res.end(JSON.stringify({ result: null }))
        return
      }
      const body = JSON.parse(raw)
      if (Array.isArray(body) && Array.isArray(body[0])) {
        res.end(JSON.stringify(body.map((command) => ({ result: runCommand(command) }))))
        return
      }
      if (!Array.isArray(body) || typeof body[0] !== 'string') {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'unsupported command' }))
        return
      }
      const result = runCommand(body)
      if (result === undefined) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: `unknown command ${body[0]}` }))
        return
      }
      res.end(JSON.stringify({ result }))
    } catch (error) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock upstash redis listening on http://127.0.0.1:${port} (keys=${store.size})`)
})
