import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const PREFIX = 'enc:v1:'

const encryptionKey = () => {
  const value = process.env.TOKEN_ENCRYPTION_KEY
  if (!value) return null
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  return key
}

export const encryptToken = (token: string) => {
  const key = encryptionKey()
  if (!key || !token) return token
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`
}

export const decryptToken = (stored: string | null | undefined) => {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const key = encryptionKey()
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is required to decrypt stored provider tokens')
  const payload = Buffer.from(stored.slice(PREFIX.length), 'base64')
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}
