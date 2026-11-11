import { object } from './types'
export const STAGE_GATES = {
  prepare: { entry: ['task.scoped', 'worker.reserved', 'capabilities.pinned'], exit: ['checkout.ready', 'worker.mount.scoped'] },
  build: { entry: ['checkout.ready', 'worker.mount.scoped'], exit: ['native.run.done', 'hooks.delivered', 'skills.read'] },
  verify: { entry: ['native.run.done'], exit: ['worker.drained', 'candidate.immutable', 'existing.tests.preserved', 'verification.passed'] },
  review: { entry: ['candidate.immutable', 'verification.passed', 'controller.pr.exact_head', 'required.ci.passed'], exit: ['native.review.done', 'review.packet.bound', 'review.assessed'] },
  merge: { entry: ['review.approved'], exit: ['trusted.review.check.passed', 'required.ci.exact_head', 'authorized.human.merge'] }
}
export function validateContract(text: string): boolean {
  const contract = object(JSON.parse(text))
  if (contract.version === 3 && contract.publication === 'controller' && JSON.stringify(contract.stages) === JSON.stringify(STAGE_GATES) && JSON.stringify(contract.correction) === JSON.stringify({ from: 'review', to: 'build', on: 'review.rejected' })) return true
  const old = { ...STAGE_GATES, review: { ...STAGE_GATES.review, exit: ['native.review.done', 'review.packet.bound'] }, merge: { ...STAGE_GATES.merge, entry: ['native.review.done'] } }
  if (contract.version === 2 && contract.publication === 'controller' && JSON.stringify(contract.stages) === JSON.stringify(old)) return false
  const legacy = JSON.parse(JSON.stringify(old).replace('controller.pr.exact_head', 'manual.pr.exact_head'))
  if (contract.version === 1 && contract.publication === 'manual' && JSON.stringify(contract.stages) === JSON.stringify(legacy)) return false
  throw new Error('Unsupported factory stage contract; update the controller and contract together')
}
