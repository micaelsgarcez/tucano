import { createServer } from 'node:http'
import { expect, test } from 'vitest'
import { Telemetry } from '../src/factory/telemetry'
test('OTLP keeps run IDs in logs, bounded metric labels and unknown USD absent', async () => {
  const bodies: { path: string; ua: string | undefined; data: string }[] = []
  const server = createServer((request, response) => { let data = ''; request.on('data', b => { data += b.toString() }); request.on('end', () => { bodies.push({ path: request.url ?? '', ua: request.headers['user-agent'], data }); response.writeHead(200).end('{}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback listener')
    const telemetry = new Telemetry(`http://127.0.0.1:${address.port}`, undefined, message => { throw new Error(message) })
    telemetry.run([{ id: 'receipt-unique', messageId: 'message-unique', inputTokens: 9, outputTokens: 3, cacheReadTokens: 2, ms: 123 }], { stage: 'build', engine: 'codex', model: 'gpt-6-astra', outcome: 'done' }, { attemptId: 'attempt-unique', jobId: 'job-unique', messageId: 'message-unique' })
    telemetry.stage(17, { stage: 'build', engine: 'codex', model: 'gpt-6-astra', outcome: 'passed' })
    await expect.poll(() => bodies.length).toBe(6)
    const metrics = bodies.filter(b => b.path === '/v1/metrics').map(b => b.data).join('\n')
    expect(metrics).not.toContain('-unique'); expect(metrics).not.toContain('central.factory.run.api_cost'); expect(metrics).toContain('garceztech'); expect(metrics).toContain('central.factory.stage.duration')
    expect(bodies.every(b => b.ua === 'central-factory/1.0')).toBe(true)
    const log = bodies.find(b => b.path === '/v1/logs')!.data
    expect(log).toContain('attempt-unique'); expect(log).toContain('receipt-unique'); expect(log).toContain('costUnknown')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('late exporter failure after close does not touch closed persistence', async () => {
  let received = false, failures = 0
  const server = createServer((request, response) => { request.resume(); request.on('end', () => { received = true; response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected listener')
    const telemetry = new Telemetry(`http://127.0.0.1:${address.port}`, undefined, () => { failures++; throw new Error('Persistence is closed') })
    telemetry.log('closing', {}); telemetry.close()
    await expect.poll(() => received).toBe(true)
    expect(failures).toBe(0)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
