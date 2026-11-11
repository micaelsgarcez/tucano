import { object } from './types'
export const STAGE_GATES = {
  prepare: { entry: ['task.scoped', 'worker.reserved', 'capabilities.pinned'], exit: ['checkout.ready', 'worker.mount.scoped'] },
  build: { entry: ['checkout.ready', 'worker.mount.scoped'], exit: ['native.run.done', 'hooks.delivered', 'skills.read'] },
  verify: { entry: ['native.run.done'], exit: ['worker.drained', 'candidate.immutable', 'existing.tests.preserved', 'verification.passed'] },
  review: { entry: ['candidate.immutable', 'verification.passed', 'controller.pr.exact_head', 'required.ci.passed'], exit: ['native.review.done', 'review.packet.bound'] },
  merge: { entry: ['native.review.done'], exit: ['trusted.review.check.passed', 'required.ci.exact_head', 'authorized.human.merge'] }
}
export function validateContract(text: string): boolean {
  const contract = object(JSON.parse(text))
  if (contract.version === 2 && contract.publication === 'controller' && JSON.stringify(contract.stages) === JSON.stringify(STAGE_GATES)) return true
  const legacy = JSON.parse(JSON.stringify(STAGE_GATES).replace('controller.pr.exact_head', 'manual.pr.exact_head'))
  if (contract.version === 1 && contract.publication === 'manual' && JSON.stringify(contract.stages) === JSON.stringify(legacy)) return false
  throw new Error('Unsupported factory stage contract; update the controller and contract together')
}
