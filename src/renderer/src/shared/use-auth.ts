import { useEffect, useState } from 'react'
import type { PoeAuthSnapshot, PoeAuthorizationPersistenceChoice } from '@shared/types'

/** Trade-site auth state. Checks login on mount; `login`/`logout` perform the
 *  action then refresh. `loggedIn` is the derived boolean for consumers that
 *  only need yes/no; `auth` is the full result (null while the first check is in
 *  flight) for consumers that show the account name. */
export function useAuth(): {
  auth: PoeAuthSnapshot | null
  loggedIn: boolean
  checkAuth: () => void
  login: (choice?: PoeAuthorizationPersistenceChoice) => Promise<void>
  cancel: () => Promise<void>
  logout: () => Promise<void>
} {
  const [auth, setAuth] = useState<PoeAuthSnapshot | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = window.api.onPoeAuthChanged((snapshot) => {
      if (active) setAuth(snapshot)
    })
    window.api.poeCheckAuth().then((snapshot) => {
      if (active) setAuth(snapshot)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const checkAuth = (): void => {
    window.api.poeCheckAuth().then(setAuth)
  }
  const login = (choice?: PoeAuthorizationPersistenceChoice): Promise<void> =>
    window.api.poeLogin(choice).then((snapshot) => setAuth(snapshot))
  const cancel = (): Promise<void> => window.api.poeCancelAuth().then((snapshot) => setAuth(snapshot))
  const logout = (): Promise<void> => window.api.poeLogout().then((snapshot) => setAuth(snapshot))

  return { auth, loggedIn: auth?.loggedIn ?? false, checkAuth, login, cancel, logout }
}
