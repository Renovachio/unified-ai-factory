export const metadata = { title: "Sign in · Unified AI Factory" };

/** Sign-in goes through the API's OIDC authorization-code + PKCE flow (same origin behind the reverse proxy); no credentials are handled here. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ return_to?: string; error?: string }> }) {
  const sp = await searchParams;
  const returnTo = sp.return_to && sp.return_to.startsWith("/") && !sp.return_to.startsWith("//") ? sp.return_to : "/";
  return (
    <section aria-labelledby="signin">
      <h1 id="signin">Sign in</h1>
      {sp.error ? <p role="alert">Sign-in failed. Ask an administrator whether your account is enabled.</p> : null}
      <p>Use your organisation's identity provider.</p>
      <a className="btn" href={`/api/v1/auth/login?return_to=${encodeURIComponent(returnTo)}`}>Continue with single sign-on</a>
    </section>
  );
}
