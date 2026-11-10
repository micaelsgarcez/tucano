import type { Usage } from './types'
type Labels = { stage: string; engine: string; model: string; outcome: string }
const attributes = (values: Record<string, string>) => Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }))
const resource = { attributes: attributes({ 'service.name': 'central-factory', company: 'garceztech', project: 'central' }) }
export class Telemetry {
  private readonly start = String(BigInt(Date.now()) * 1_000_000n)
  private closed = false
  close(): void { this.closed = true }
  private totals = new Map<string, number>()
  constructor(private readonly endpoint: string | undefined, private readonly token: string | undefined, private readonly failure: (message: string) => void) {}
  private post(path: string, body: unknown): void {
    if (!this.endpoint || this.closed) return
    void fetch(`${this.endpoint.replace(/\/$/, '')}/v1/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'central-factory/1.0', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      .then(response => { if (!response.ok) throw new Error(`OTLP ${path} HTTP ${response.status}`) })
      .catch(error => { if (!this.closed) { try { this.failure(error instanceof Error ? error.message : 'OTLP export failed') } catch {} } })
  }
  log(event: string, evidence: unknown): void {
    this.post('logs', { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'central.factory', version: '1' }, logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), severityNumber: 9, severityText: 'INFO', body: { stringValue: JSON.stringify({ event, evidence }) } }] }] }] })
  }
  private metric(name: string, unit: string, value: number, labels: Record<string, string>, cumulative: boolean): void {
    const key = `${name}:${JSON.stringify(labels)}`
    if (cumulative) { value += this.totals.get(key) ?? 0; this.totals.set(key, value) }
    const point = { attributes: attributes(labels), startTimeUnixNano: this.start, timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), asDouble: value }
    const metric = { name, unit, ...(cumulative ? { sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [point] } } : { gauge: { dataPoints: [point] } }) }
    this.post('metrics', { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: 'central.factory', version: '1' }, metrics: [metric] }] }] })
  }
  stage(seconds: number, labels: Labels): void { this.metric('central.factory.stage.duration', 's', seconds, labels, false) }
  run(usage: Usage[], labels: Labels, ids: { attemptId: string; jobId: string; messageId: string }): void {
    const ms = usage.reduce((sum, receipt) => sum + receipt.ms, 0)
    this.metric('central.factory.run.duration', 's', ms / 1000, labels, false)
    for (const [direction, value] of [['input', usage.reduce((s, r) => s + r.inputTokens, 0)], ['output', usage.reduce((s, r) => s + r.outputTokens, 0)], ['cache_read', usage.reduce((s, r) => s + r.cacheReadTokens, 0)]] as const) this.metric('central.factory.run.tokens', '{token}', value, { ...labels, direction }, true)
    const known = usage.length > 0 && usage.every(receipt => receipt.apiCostUsd !== undefined)
    const usd = known ? usage.reduce((sum, receipt) => sum + (receipt.apiCostUsd ?? 0), 0) : null
    if (usd !== null) this.metric('central.factory.run.api_cost', 'USD', usd, labels, true)
    this.log('native.run.completed', { ...ids, ...labels, receiptIds: usage.map(r => r.id), modelMs: ms, apiEquivalentUsd: usd, costUnknown: !known, usage })
  }
}
