import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { DispatchLifecycle } from '../ports/state'
import { controlKernelLifecycleKey } from './control-kernel-task-packet'
import { FileStateStore } from './file-state-store'

const lifecycleSeed = (attemptId: string): DispatchLifecycle => ({
  runId: attemptId,
  issue: {
    key: 'issue-22',
    uuid: 'control-kernel:issue-22',
    path: '/control-kernel/issues/issue-22.json',
  },
  decision: {
    issue: {
      key: 'issue-22',
      uuid: 'control-kernel:issue-22',
      path: '/control-kernel/issues/issue-22.json',
    },
    routes: [],
    scope: 'single',
    implementers: [],
    reviewer: {
      name: 'control-kernel-reviewer',
      role: 'reviewer',
      capability: 'spawn:codex',
      task: 'control-kernel receipt review',
      repo: 'AgentWorkforce/factory',
    },
    thin: true,
    confidence: 'high',
    rationale: 'control-kernel state-store fixture',
  },
  dryRun: false,
  phase: 'dispatching',
  agents: [],
  invocationIds: [],
  updatedAtMs: 0,
})

describe('control-kernel task packets', () => {
  it('rejects a malformed input revision before admitting a task packet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-invalid-input-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const packet = {
        issueId: 'issue-22',
        taskId: 'packet-exact-input',
        inputRevision: 'abc123',
        attemptId: 'attempt-invalid-input',
        generation: 1,
      }

      const result = await store.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )

      expect(result).toEqual({ accepted: false, reason: 'invalid-input-revision' })
      await expect(readFile(watchStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('admits an exact task packet with a native owner and generation lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-admission-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const packet = {
        issueId: 'issue-22',
        taskId: 'single-winner-race',
        inputRevision: '0123456789abcdef0123456789abcdef01234567',
        attemptId: 'attempt-admission',
        generation: 1,
      }

      const result = await store.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )

      expect(result).toMatchObject({
        accepted: true,
        replayed: false,
        lease: { owner: 'owner-a', epoch: 1, leaseUntilMs: 1_100 },
      })
      expect(result).toHaveProperty('receipt')
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', packet.issueId, packet.taskId,
      )).toEqual({
        issueId: packet.issueId,
        taskId: packet.taskId,
        inputRevision: packet.inputRevision,
        attemptId: packet.attemptId,
        generation: packet.generation,
        phase: 'claimed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays an admitted claim byte-for-byte after reopening the state store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-claim-replay-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const packet = {
        issueId: 'issue-22',
        taskId: 'replay-and-reopen',
        inputRevision: '89abcdef0123456789abcdef0123456789abcdef',
        attemptId: 'attempt-claim-replay',
        generation: 1,
      }
      const firstStore = new FileStateStore({ batchSize: 1, watchStatePath })
      const first = await firstStore.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )
      expect(first.accepted).toBe(true)
      if (!first.accepted) return

      const reopened = new FileStateStore({ batchSize: 1, watchStatePath })
      const replay = await reopened.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_050, 100,
      )

      expect(replay).toMatchObject({ accepted: true, replayed: true })
      if (replay.accepted) expect(replay.receipt).toBe(first.receipt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects changed input and global attempt reuse without mutating an admitted packet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-conflicts-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 2, watchStatePath })
      const admitted = {
        issueId: 'issue-22',
        taskId: 'conflicting-input-and-attempt-reuse',
        inputRevision: 'fedcba9876543210fedcba9876543210fedcba98',
        attemptId: 'attempt-global-conflict',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', admitted, lifecycleSeed(admitted.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      const before = await store.getControlKernelTaskPacket(
        'control-kernel', admitted.issueId, admitted.taskId,
      )

      const changedInput = await store.claimControlKernelTaskPacket(
        'control-kernel', {
          ...admitted,
          inputRevision: '00112233445566778899aabbccddeeff00112233',
          attemptId: 'attempt-changed-input',
        }, lifecycleSeed('attempt-changed-input'), 'owner-b', 1_001, 100,
      )
      const reusedAttempt = await store.claimControlKernelTaskPacket(
        'control-kernel', {
          ...admitted,
          taskId: 'different-task',
        }, lifecycleSeed(admitted.attemptId), 'owner-b', 1_001, 100,
      )

      expect(changedInput).toEqual({ accepted: false, reason: 'input-revision-conflict' })
      expect(reusedAttempt).toEqual({ accepted: false, reason: 'attempt-id-conflict' })
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', admitted.issueId, admitted.taskId,
      )).toEqual(before)
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', admitted.issueId, 'different-task',
      )).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('denies a different attempt from replacing a live checkpointed task packet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-live-attempt-conflict-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const admitted = {
        issueId: 'issue-22',
        taskId: 'same-input-live-attempt-conflict',
        inputRevision: '0123456789abcdef0123456789abcdef01234567',
        attemptId: 'attempt-live-owner-a',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', admitted, lifecycleSeed(admitted.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      expect((await store.checkpointControlKernelTaskPacket(
        'control-kernel', admitted, 'owner-a', 1_001,
      )).accepted).toBe(true)
      const before = await readFile(watchStatePath, 'utf8')

      const replacement = await store.claimControlKernelTaskPacket(
        'control-kernel', {
          ...admitted,
          attemptId: 'attempt-live-owner-a-replacement',
        }, lifecycleSeed('attempt-live-owner-a-replacement'), 'owner-a', 1_002, 100,
      )

      expect(replacement).toEqual({ accepted: false, reason: 'attempt-id-conflict' })
      expect(await readFile(watchStatePath, 'utf8')).toBe(before)
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', admitted.issueId, admitted.taskId,
      )).toMatchObject({
        attemptId: admitted.attemptId,
        generation: admitted.generation,
        phase: 'checkpointed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('denies a changed well-formed input revision before checkpoint or completion replay or mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-operation-input-conflict-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const packet = {
        issueId: 'issue-22',
        taskId: 'changed-input-denial',
        inputRevision: '0123456789abcdef0123456789abcdef01234567',
        attemptId: 'attempt-operation-input-conflict',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      expect((await store.checkpointControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_001,
      )).accepted).toBe(true)
      const before = await readFile(watchStatePath, 'utf8')
      const changed = {
        ...packet,
        inputRevision: '00112233445566778899aabbccddeeff00112233',
      }

      const changedCheckpoint = await store.checkpointControlKernelTaskPacket(
        'control-kernel', changed, 'owner-a', 1_002,
      )
      const changedCompletion = await store.completeControlKernelTaskPacket(
        'control-kernel', changed, 'owner-a', 1_002,
      )

      expect(changedCheckpoint).toEqual({ accepted: false, reason: 'input-revision-conflict' })
      expect(changedCompletion).toEqual({ accepted: false, reason: 'input-revision-conflict' })
      expect(await readFile(watchStatePath, 'utf8')).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires a checkpoint before completion and denies a checkpoint after terminal completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-illegal-transition-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const packet = {
        issueId: 'issue-22',
        taskId: 'illegal-transition-denial',
        inputRevision: '89abcdef0123456789abcdef0123456789abcdef',
        attemptId: 'attempt-illegal-transition',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)

      const prematureCompletion = await store.completeControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_001,
      )

      expect(prematureCompletion).toEqual({ accepted: false, reason: 'illegal-transition' })
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', packet.issueId, packet.taskId,
      )).toMatchObject({ phase: 'claimed' })
      expect((await store.checkpointControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_002,
      )).accepted).toBe(true)
      expect((await store.completeControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_003,
      )).accepted).toBe(true)

      const terminalCheckpoint = await store.checkpointControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_004,
      )

      expect(terminalCheckpoint).toEqual({ accepted: false, reason: 'illegal-transition' })
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', packet.issueId, packet.taskId,
      )).toMatchObject({ phase: 'complete' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an admitted task binding through generic lifecycle clear and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-clear-reopen-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const packet = {
        issueId: 'issue-22',
        taskId: 'changed-input-denial',
        inputRevision: '0123456789abcdef0123456789abcdef01234567',
        attemptId: 'attempt-clear-reopen',
        generation: 1,
      }
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)

      await store.clearDispatchLifecycle('control-kernel', controlKernelLifecycleKey(packet))
      const reopened = new FileStateStore({ batchSize: 1, watchStatePath })
      const readmission = await reopened.claimControlKernelTaskPacket(
        'control-kernel', {
          ...packet,
          inputRevision: '00112233445566778899aabbccddeeff00112233',
          attemptId: 'attempt-clear-reopen-changed-input',
        }, lifecycleSeed('attempt-clear-reopen-changed-input'), 'owner-b', 1_001, 100,
      )

      expect(readmission).toEqual({ accepted: false, reason: 'input-revision-conflict' })
      expect(await reopened.getControlKernelTaskPacket(
        'control-kernel', packet.issueId, packet.taskId,
      )).toMatchObject({ inputRevision: packet.inputRevision, attemptId: packet.attemptId })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the same-input generation fence through generic lifecycle clear and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-clear-same-input-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const initial = {
        issueId: 'issue-22',
        taskId: 'same-input-cleanup-fence',
        inputRevision: '89abcdef0123456789abcdef0123456789abcdef',
        attemptId: 'attempt-clear-same-input-owner-a',
        generation: 1,
      }
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', initial, lifecycleSeed(initial.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      expect((await store.checkpointControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_001,
      )).accepted).toBe(true)
      const before = await readFile(watchStatePath, 'utf8')

      await store.clearDispatchLifecycle('control-kernel', controlKernelLifecycleKey(initial))
      const reopened = new FileStateStore({ batchSize: 1, watchStatePath })
      const generationOneReadmission = await reopened.claimControlKernelTaskPacket(
        'control-kernel', {
          ...initial,
          attemptId: 'attempt-clear-same-input-owner-b',
        }, lifecycleSeed('attempt-clear-same-input-owner-b'), 'owner-b', 1_002, 100,
      )

      expect(generationOneReadmission).toEqual({ accepted: false, reason: 'attempt-id-conflict' })
      expect(await readFile(watchStatePath, 'utf8')).toBe(before)

      const successor = {
        ...initial,
        attemptId: 'attempt-clear-same-input-owner-b',
        generation: 2,
      }
      const generationTwoReadmission = await reopened.claimControlKernelTaskPacket(
        'control-kernel', successor, lifecycleSeed(successor.attemptId), 'owner-b', 1_101, 100,
      )

      expect(generationTwoReadmission).toMatchObject({
        accepted: true,
        lease: { owner: 'owner-b', epoch: 2 },
      })
      const document = JSON.parse(await readFile(watchStatePath, 'utf8'))
      expect(document.controlKernelTaskPacketAttempts).toHaveProperty(initial.attemptId)
      expect(document.controlKernelTaskPacketAttempts).toHaveProperty(successor.attemptId)
      expect(await reopened.getControlKernelTaskPacket(
        'control-kernel', initial.issueId, initial.taskId,
      )).toMatchObject({ attemptId: successor.attemptId, generation: 2, phase: 'claimed' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed on missing or inconsistent task packet authority bindings after restart', async () => {
    const corruptions = [
      {
        name: 'missing current attempt',
        corrupt: (document: any, packet: { attemptId: string }) => {
          delete document.controlKernelTaskPacketAttempts[packet.attemptId]
        },
      },
      {
        name: 'missing bound lifecycle',
        corrupt: (document: any, packet: { issueId: string, taskId: string }) => {
          delete document.workspaces['control-kernel'].dispatchLifecycles[
            `control-kernel:["${packet.issueId}","${packet.taskId}"]`
          ]
        },
      },
      {
        name: 'inconsistent attempt generation',
        corrupt: (document: any, packet: { attemptId: string }) => {
          document.controlKernelTaskPacketAttempts[packet.attemptId].packet.generation = 2
        },
      },
      {
        name: 'checkpoint phase regressed without matching receipt state',
        corrupt: (document: any) => {
          document.workspaces['control-kernel'].controlKernelTaskPackets[
            '["issue-22","corrupt-restart-binding"]'
          ].phase = 'claimed'
        },
      },
    ]
    for (const { name, corrupt } of corruptions) {
      const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-corrupt-restart-'))
      const watchStatePath = join(root, 'state.json')
      try {
        const packet = {
          issueId: 'issue-22',
          taskId: 'corrupt-restart-binding',
          inputRevision: '13579bdf2468ace013579bdf2468ace013579bdf',
          attemptId: 'attempt-corrupt-restart',
          generation: 1,
        }
        const store = new FileStateStore({ batchSize: 1, watchStatePath })
        expect((await store.claimControlKernelTaskPacket(
          'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
        )).accepted).toBe(true)
        expect((await store.checkpointControlKernelTaskPacket(
          'control-kernel', packet, 'owner-a', 1_001,
        )).accepted).toBe(true)
        const document = JSON.parse(await readFile(watchStatePath, 'utf8'))
        corrupt(document, packet)
        await writeFile(watchStatePath, JSON.stringify(document), 'utf8')
        const corruptedBytes = await readFile(watchStatePath, 'utf8')
        const reopened = new FileStateStore({ batchSize: 1, watchStatePath })

        await expect(reopened.assertReady(), name).rejects.toThrow()
        expect(await readFile(watchStatePath, 'utf8'), name).toBe(corruptedBytes)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('increments generation after expiry and fences the prior owner from checkpoint and completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-takeover-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const initial = {
        issueId: 'issue-22',
        taskId: 'expired-takeover-fences-stale-owner',
        inputRevision: '13579bdf2468ace013579bdf2468ace013579bdf',
        attemptId: 'attempt-owner-a',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', initial, lifecycleSeed(initial.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      const successor = {
        ...initial,
        attemptId: 'attempt-owner-b',
        generation: 2,
      }
      const takeover = await store.claimControlKernelTaskPacket(
        'control-kernel', successor, lifecycleSeed(successor.attemptId), 'owner-b', 1_101, 100,
      )
      expect(takeover).toMatchObject({ accepted: true, lease: { owner: 'owner-b', epoch: 2 } })

      const staleCheckpoint = await store.checkpointControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_102,
      )
      const staleCompletion = await store.completeControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_102,
      )

      expect(staleCheckpoint).toEqual({ accepted: false, reason: 'stale-owner' })
      expect(staleCompletion).toEqual({ accepted: false, reason: 'stale-owner' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('increments generation for a different attempt after expiry even when the owner string is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-same-owner-takeover-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const initial = {
        issueId: 'issue-22',
        taskId: 'same-owner-expired-takeover',
        inputRevision: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        attemptId: 'attempt-same-owner-a',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', initial, lifecycleSeed(initial.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      expect((await store.checkpointControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_001,
      )).accepted).toBe(true)
      const before = await readFile(watchStatePath, 'utf8')

      const generationOneSuccessor = {
        ...initial,
        attemptId: 'attempt-same-owner-a-successor',
      }
      const rejected = await store.claimControlKernelTaskPacket(
        'control-kernel', generationOneSuccessor, lifecycleSeed(generationOneSuccessor.attemptId), 'owner-a', 1_101, 100,
      )

      expect(rejected).toEqual({ accepted: false, reason: 'generation-conflict' })
      expect(await readFile(watchStatePath, 'utf8')).toBe(before)
      expect(await store.getControlKernelTaskPacket(
        'control-kernel', initial.issueId, initial.taskId,
      )).toMatchObject({
        attemptId: initial.attemptId,
        generation: 1,
        phase: 'checkpointed',
      })

      const generationTwoSuccessor = { ...generationOneSuccessor, generation: 2 }
      expect(await store.claimControlKernelTaskPacket(
        'control-kernel', generationTwoSuccessor, lifecycleSeed(generationTwoSuccessor.attemptId), 'owner-a', 1_101, 100,
      )).toMatchObject({ accepted: true, lease: { owner: 'owner-a', epoch: 2 } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reserves control-kernel lifecycle claims from generic same-owner takeover after expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-generic-same-owner-takeover-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const store = new FileStateStore({ batchSize: 1, watchStatePath })
      const initial = {
        issueId: 'issue-22',
        taskId: 'generic-same-owner-expired-takeover',
        inputRevision: 'bcdefabcdefabcdefabcdefabcdefabcdefabcde',
        attemptId: 'attempt-generic-same-owner-a',
        generation: 1,
      }
      expect((await store.claimControlKernelTaskPacket(
        'control-kernel', initial, lifecycleSeed(initial.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      expect((await store.checkpointControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_001,
      )).accepted).toBe(true)
      const before = await readFile(watchStatePath, 'utf8')

      const genericClaim = await store.claimDispatchLifecycle(
        'control-kernel', controlKernelLifecycleKey(initial), lifecycleSeed('generic-attempt'), 'owner-a', 1_101, 100,
      )

      expect(genericClaim).toMatchObject({ acquired: false, created: false })
      expect(await readFile(watchStatePath, 'utf8')).toBe(before)
      await expect(store.checkpointControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_102,
      )).resolves.toEqual({ accepted: false, reason: 'stale-owner' })
      await expect(store.completeControlKernelTaskPacket(
        'control-kernel', initial, 'owner-a', 1_102,
      )).resolves.toEqual({ accepted: false, reason: 'stale-owner' })

      const successor = {
        ...initial,
        attemptId: 'attempt-generic-same-owner-a-successor',
        generation: 2,
      }
      expect(await store.claimControlKernelTaskPacket(
        'control-kernel', successor, lifecycleSeed(successor.attemptId), 'owner-a', 1_103, 100,
      )).toMatchObject({ accepted: true, lease: { owner: 'owner-a', epoch: 2 } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays a checkpoint receipt byte-for-byte after reopening the state store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-checkpoint-replay-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const packet = {
        issueId: 'issue-22',
        taskId: 'checkpoint-replay',
        inputRevision: '2468ace02468ace02468ace02468ace02468ace0',
        attemptId: 'attempt-checkpoint-replay',
        generation: 1,
      }
      const firstStore = new FileStateStore({ batchSize: 1, watchStatePath })
      expect((await firstStore.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      const checkpoint = await firstStore.checkpointControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_001,
      )
      expect(checkpoint).toMatchObject({ accepted: true, replayed: false })

      const reopened = new FileStateStore({ batchSize: 1, watchStatePath })
      const replay = await reopened.checkpointControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_050,
      )
      expect(replay).toMatchObject({ accepted: true, replayed: true })
      expect(replay.receipt).toBe(checkpoint.receipt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays a completion receipt byte-for-byte after reopening the state store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-control-kernel-completion-replay-'))
    const watchStatePath = join(root, 'state.json')
    try {
      const packet = {
        issueId: 'issue-22',
        taskId: 'completion-replay',
        inputRevision: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        attemptId: 'attempt-completion-replay',
        generation: 1,
      }
      const firstStore = new FileStateStore({ batchSize: 1, watchStatePath })
      expect((await firstStore.claimControlKernelTaskPacket(
        'control-kernel', packet, lifecycleSeed(packet.attemptId), 'owner-a', 1_000, 100,
      )).accepted).toBe(true)
      expect((await firstStore.checkpointControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_001,
      )).accepted).toBe(true)
      const completion = await firstStore.completeControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_002,
      )
      expect(completion).toMatchObject({ accepted: true, replayed: false })

      const reopened = new FileStateStore({ batchSize: 1, watchStatePath })
      const replay = await reopened.completeControlKernelTaskPacket(
        'control-kernel', packet, 'owner-a', 1_050,
      )
      expect(replay).toMatchObject({ accepted: true, replayed: true })
      expect(replay.receipt).toBe(completion.receipt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
