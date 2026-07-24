import { useAuth } from '@renderer/shared/use-auth'

export function PoeLoginButton(): JSX.Element {
  const { auth, login, cancel, logout } = useAuth()

  if (auth === null) return <span className="text-[11px] text-text-dim">Checking...</span>

  if (auth.loggedIn) {
    return (
      <div>
        <div className="setting-box">
          <span className="value text-accent">
            Authorized as {auth.accountName}
            {auth.persistence === 'memory-only' ? ' (memory-only)' : ''}
          </span>
          <button className="text-[11px] text-text-dim shrink-0 ml-2 px-3 py-[5px]" onClick={() => void logout()}>
            Logout
          </button>
        </div>
        {auth.error && <div className="text-[10px] text-warning mt-1">{auth.error.message}</div>}
        <NonAffiliationNotice />
      </div>
    )
  }

  if (auth.status === 'authorizing') {
    return (
      <div>
        <div className="setting-box">
          <span className="value text-text-dim">Finish authorization in your browser…</span>
          <button onClick={() => void cancel()}>Cancel</button>
        </div>
        <NonAffiliationNotice />
      </div>
    )
  }

  const unavailable = auth.status === 'unavailable'
  const needsMemoryChoice = auth.error?.reason === 'insecure-keyring'
  return (
    <div>
      <div className="setting-box">
        <span className="value text-text-dim">
          {auth.status === 'expired' ? 'Authorization expired' : unavailable ? 'OAuth unavailable' : 'Not authorized'}
        </span>
        {!unavailable && (
          <button className="primary" onClick={() => void login('encrypted')}>
            Authorize in Browser
          </button>
        )}
      </div>
      {auth.error && <div className="text-[10px] text-warning mt-1">{auth.error.message}</div>}
      {needsMemoryChoice && (
        <button className="mt-2 text-[10px]" onClick={() => void login('memory-only')}>
          Continue memory-only for this process
        </button>
      )}
      <NonAffiliationNotice />
    </div>
  )
}

function NonAffiliationNotice(): JSX.Element {
  return (
    <p className="text-[9px] text-text-dim mt-2">
      This product isn&apos;t affiliated with or endorsed by Grinding Gear Games in any way.
    </p>
  )
}
