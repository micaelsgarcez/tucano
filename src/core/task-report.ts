import type { ToolDef } from './gateway'
import { L } from '../shared/lang'

export const TASK_REPORT: ToolDef = {
  name: 'report_task',
  description: 'Record a task progress report: action, result and next step. Use a new short key per meaningful unit of work; repeat the same key and content only to retry delivery. Completed execution steps are attached as evidence by Tucano. Do not include credentials or raw tool output.',
  inputSchema: { type: 'object', properties: { key: { type: 'string' }, action: { type: 'string' }, result: { type: 'string' }, nextStep: { type: 'string' } }, required: ['key', 'action', 'result', 'nextStep'] }
}
export function taskReportInput(args: Record<string, unknown>): { key: string; action: string; result: string; nextStep: string } {
  const { key, action, result, nextStep } = args
  if (typeof key !== 'string' || typeof action !== 'string' || typeof result !== 'string' || typeof nextStep !== 'string' || !key.trim() || key.length > 100 || [action, result, nextStep].some(value => !value.trim() || value.length > 4000)) {
    throw new Error(L('Informe chave, ação, resultado e próximo passo válidos.', 'Provide a valid key, action, result and next step.'))
  }
  return { key, action, result, nextStep }
}
