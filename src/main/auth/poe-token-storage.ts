import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface PoeTokenRecord {
  accessToken: string
  refreshToken: string
  tokenType: 'bearer'
  scopes: string[]
  accountName: string
  subject?: string
  accessExpiresAt: number
  refreshExpiresAt: number
}

export interface TokenCipher {
  isSecure(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface StoredEnvelope {
  version: 1
  ciphertext: string
}

function isTokenRecord(value: unknown): value is PoeTokenRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PoeTokenRecord>
  return (
    typeof item.accessToken === 'string' &&
    item.accessToken.length > 0 &&
    typeof item.refreshToken === 'string' &&
    item.refreshToken.length > 0 &&
    item.tokenType === 'bearer' &&
    Array.isArray(item.scopes) &&
    item.scopes.every((scope) => typeof scope === 'string') &&
    typeof item.accountName === 'string' &&
    typeof item.accessExpiresAt === 'number' &&
    Number.isFinite(item.accessExpiresAt) &&
    typeof item.refreshExpiresAt === 'number' &&
    Number.isFinite(item.refreshExpiresAt)
  )
}

/** One versioned safeStorage ciphertext, replaced atomically. */
export class PoeTokenStorage {
  constructor(
    private readonly filePath: string,
    private readonly cipher: TokenCipher,
  ) {}

  isSecure(): boolean {
    return this.cipher.isSecure()
  }

  async load(): Promise<PoeTokenRecord | null> {
    if (!this.cipher.isSecure()) return null
    try {
      const envelope = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredEnvelope>
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string') return null
      const plaintext = this.cipher.decrypt(Buffer.from(envelope.ciphertext, 'base64'))
      const parsed: unknown = JSON.parse(plaintext)
      return isTokenRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async save(record: PoeTokenRecord): Promise<void> {
    if (!this.cipher.isSecure()) throw new Error('Secure credential storage is unavailable')
    await mkdir(dirname(this.filePath), { recursive: true })
    const encrypted = this.cipher.encrypt(JSON.stringify(record))
    const envelope: StoredEnvelope = { version: 1, ciphertext: encrypted.toString('base64') }
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
