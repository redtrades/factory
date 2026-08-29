import type { DispatchLifecycleLease } from '../ports/state'

export type ControlKernelTaskPacket = {
  issueId: string
  taskId: string
  inputRevision: string
  attemptId: string
  generation: number
}

export type ControlKernelTaskPacketPhase = 'claimed' | 'checkpointed' | 'complete'

export type ControlKernelTaskPacketState = ControlKernelTaskPacket & {
  phase: ControlKernelTaskPacketPhase
  lifecycleKey: string
}

export type ControlKernelTaskPacketAttempt = {
  packet: ControlKernelTaskPacket
  owner: string
  lifecycleKey: string
  receipts: {
    claim: string
    checkpoint?: string
    complete?: string
  }
}

export type ControlKernelTaskPacketClaim =
  | {
    accepted: true
    replayed: boolean
    receipt: string
    lease: DispatchLifecycleLease
  }
  | {
    accepted: false
    reason:
      | 'invalid-input-revision'
      | 'invalid-task-packet'
      | 'seed-attempt-mismatch'
      | 'migration-alias-seed'
      | 'generation-conflict'
      | 'lease-held'
      | 'terminal'
      | 'input-revision-conflict'
      | 'attempt-id-conflict'
  }

export type ControlKernelTaskPacketOperation =
  | {
    accepted: true
    replayed: boolean
    receipt: string
  }
  | {
    accepted: false
    reason:
      | 'invalid-input-revision'
      | 'invalid-task-packet'
      | 'input-revision-conflict'
      | 'illegal-transition'
      | 'stale-owner'
  }

const INPUT_REVISION = /^[0-9a-f]{40}$/u

export const isControlKernelTaskPacket = (value: unknown): value is ControlKernelTaskPacket => {
  if (!isRecord(value)) return false
  return typeof value.issueId === 'string' && value.issueId.length > 0 &&
    typeof value.taskId === 'string' && value.taskId.length > 0 &&
    typeof value.inputRevision === 'string' && INPUT_REVISION.test(value.inputRevision) &&
    typeof value.attemptId === 'string' && value.attemptId.length > 0 &&
    typeof value.generation === 'number' && Number.isSafeInteger(value.generation) && value.generation >= 1
}

export const controlKernelTaskPacketKey = (packet: Pick<ControlKernelTaskPacket, 'issueId' | 'taskId'>): string =>
  JSON.stringify([packet.issueId, packet.taskId])

export const controlKernelLifecycleKey = (packet: Pick<ControlKernelTaskPacket, 'issueId' | 'taskId'>): string =>
  `control-kernel:${controlKernelTaskPacketKey(packet)}`

export const isControlKernelLifecycleKey = (key: string): boolean => key.startsWith('control-kernel:')

export const publicControlKernelTaskPacketState = (
  state: ControlKernelTaskPacketState,
): Omit<ControlKernelTaskPacketState, 'lifecycleKey'> => {
  const { lifecycleKey: _lifecycleKey, ...publicState } = state
  return structuredClone(publicState)
}

export const parseControlKernelTaskPacketStates = (
  value: Record<string, unknown>,
): Record<string, ControlKernelTaskPacketState> => {
  const states: Record<string, ControlKernelTaskPacketState> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!isControlKernelTaskPacketState(candidate) || key !== controlKernelTaskPacketKey(candidate)) {
      throw new Error('invalid control-kernel task-packet state')
    }
    states[key] = structuredClone(candidate)
  }
  return states
}

export const parseControlKernelTaskPacketAttempts = (
  value: Record<string, unknown>,
): Record<string, ControlKernelTaskPacketAttempt> => {
  const attempts: Record<string, ControlKernelTaskPacketAttempt> = {}
  for (const [attemptId, candidate] of Object.entries(value)) {
    if (!isControlKernelTaskPacketAttempt(candidate) || attemptId !== candidate.packet.attemptId) {
      throw new Error('invalid control-kernel attempt binding')
    }
    attempts[attemptId] = structuredClone(candidate)
  }
  return attempts
}

export const controlKernelClaimReceipt = (
  packet: ControlKernelTaskPacket,
  owner: string,
  lease: DispatchLifecycleLease,
): string => controlKernelOperationReceipt('claim', packet, owner, lease)

export const controlKernelOperationReceipt = (
  operation: 'checkpoint' | 'claim' | 'complete',
  packet: ControlKernelTaskPacket,
  owner: string,
  lease: DispatchLifecycleLease,
): string => `${canonicalJson({
  schema_version: 'agentworkforce-control-kernel-receipt/v1',
  operation,
  owner,
  lease: {
    epoch: lease.epoch,
    lease_until_ms: lease.leaseUntilMs,
  },
  task_packet: {
    attempt_id: packet.attemptId,
    generation: packet.generation,
    input_revision: packet.inputRevision,
    issue_id: packet.issueId,
    task_id: packet.taskId,
  },
})}\n`

const isControlKernelTaskPacketState = (value: unknown): value is ControlKernelTaskPacketState => {
  if (!isControlKernelTaskPacket(value)) return false
  const candidate = value as ControlKernelTaskPacket & Record<string, unknown>
  return typeof candidate.lifecycleKey === 'string' &&
    candidate.lifecycleKey === controlKernelLifecycleKey(value) &&
    (candidate.phase === 'claimed' || candidate.phase === 'checkpointed' || candidate.phase === 'complete')
}

const isControlKernelTaskPacketAttempt = (value: unknown): value is ControlKernelTaskPacketAttempt => {
  if (!isRecord(value) || !isControlKernelTaskPacket(value.packet)) return false
  const candidate = value as Record<string, unknown>
  const receipts = candidate.receipts
  return typeof candidate.owner === 'string' && candidate.owner.length > 0 &&
    typeof candidate.lifecycleKey === 'string' && candidate.lifecycleKey === controlKernelLifecycleKey(value.packet) &&
    isRecord(receipts) && typeof receipts.claim === 'string' &&
    (receipts.checkpoint === undefined || typeof receipts.checkpoint === 'string') &&
    (receipts.complete === undefined || typeof receipts.complete === 'string')
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
