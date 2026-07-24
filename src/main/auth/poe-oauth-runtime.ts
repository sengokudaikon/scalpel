import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, session, shell } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import { POE_WEBSITE } from '@shared/endpoints'
import { loadPoeOAuthConfig } from './poe-oauth-config'
import { PoeOAuthManager } from './poe-oauth-manager'
import { PoeTokenStorage, type TokenCipher } from './poe-token-storage'

let manager: PoeOAuthManager | null = null

function createCipher(): TokenCipher {
  return {
    isSecure: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
    },
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  }
}

export function getPoeOAuthManager(): PoeOAuthManager {
  if (manager) return manager
  const storage = new PoeTokenStorage(join(app.getPath('userData'), 'poe-oauth-tokens.v1'), createCipher())
  manager = new PoeOAuthManager(loadPoeOAuthConfig(), storage, {
    openExternal: (url) => shell.openExternal(url),
  })
  manager.onChange((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.TRADE.POE_AUTH_CHANGED_EVENT, snapshot)
    }
  })
  return manager
}

/** Remove credentials left by pre-OAuth releases; they are never read or copied. */
async function clearLegacyPoeCookies(): Promise<void> {
  const urls = [POE_WEBSITE, 'https://api.pathofexile.com']
  await Promise.all(
    urls.map((url) =>
      session.defaultSession.cookies.remove(url, 'POESESSID').catch(() => {
        // Cleanup is best-effort and never changes OAuth state.
      }),
    ),
  )
}

export async function initializePoeOAuth(): Promise<void> {
  await clearLegacyPoeCookies()
  await getPoeOAuthManager().initialize()
}

export function _resetPoeOAuthRuntimeForTests(): void {
  manager = null
}
