import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PoeTokenStorage, type PoeTokenRecord, type TokenCipher } from './poe-token-storage'

const directories: string[] = []

const record: PoeTokenRecord = {
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  tokenType: 'bearer',
  scopes: ['account:profile', 'account:trade'],
  accountName: 'ScalpelTest',
  accessExpiresAt: 20_000,
  refreshExpiresAt: 30_000,
}

function cipher(secure = true): TokenCipher {
  return {
    isSecure: () => secure,
    encrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)),
    decrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)).toString(),
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PoeTokenStorage', () => {
  it('stores one versioned ciphertext without serialized tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scalpel-oauth-'))
    directories.push(directory)
    const path = join(directory, 'tokens')
    const storage = new PoeTokenStorage(path, cipher())

    await storage.save(record)

    const serialized = await readFile(path, 'utf8')
    expect(serialized).not.toContain(record.accessToken)
    expect(serialized).not.toContain(record.refreshToken)
    expect(JSON.parse(serialized)).toMatchObject({ version: 1 })
    expect(await storage.load()).toEqual(record)
  })

  it('refuses persistence when the platform storage backend is insecure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scalpel-oauth-'))
    directories.push(directory)
    const storage = new PoeTokenStorage(join(directory, 'tokens'), cipher(false))
    await expect(storage.save(record)).rejects.toThrow('Secure credential storage')
    expect(await storage.load()).toBeNull()
  })
})
