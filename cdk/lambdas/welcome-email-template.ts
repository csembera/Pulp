// Welcome email for new beta testers, rendered by the Cognito CustomMessage
// trigger and delivered via SES. This module is the runtime source of truth
// for the email markup.
//
// Cognito performs two substitutions on the body AFTER our Lambda returns:
//   {####}     → the user's temporary password
//   {username} → the user's username (their email, since signInAliases.email)
// Keep both placeholders verbatim in the output for AdminCreateUser invitations.

export const WELCOME_EMAIL_SUBJECT = 'Your Pulp beta access is ready';

export interface WelcomeEmailArgs {
  // CTA target — typically the deployed CloudFront URL or custom domain.
  signInUrl: string;
}

export function renderWelcomeEmail({ signInUrl }: WelcomeEmailArgs): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Pulp – Beta Access</title>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0f;font-family:'Georgia',serif;">

  <span style="display:none;max-height:0;overflow:hidden;">
    You're in. Your Pulp beta access is ready.
  </span>

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#0f0f0f;">
    <tr>
      <td align="center" style="padding:48px 16px;">

        <table width="600" cellpadding="0" cellspacing="0" role="presentation"
          style="background-color:#141414;border:1px solid #2a2a2a;border-radius:4px;overflow:hidden;max-width:600px;width:100%;">

          <tr>
            <td style="background-color:#3B82F6;padding:6px 40px;">
              <p style="margin:0;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.15em;color:#ffffff;text-transform:uppercase;">
                Private Beta · Early Access
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:52px 40px 32px;">
              <p style="margin:0 0 40px;font-family:'Georgia',serif;font-size:38px;font-weight:normal;letter-spacing:-0.02em;color:#f5f0e8;">
                Pulp<span style="color:#3B82F6;">.</span>
              </p>

              <h1 style="margin:0 0 16px;font-family:'Georgia',serif;font-size:26px;font-weight:normal;line-height:1.3;color:#f5f0e8;letter-spacing:-0.01em;">
                Your beta access is confirmed.
              </h1>

              <p style="margin:0 0 32px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#888;">
                Thanks for joining the Pulp private beta. You're among the first to turn dense documents into structured learning — summaries, quizzes, and key terms, generated in seconds.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border-top:1px solid #222;padding-bottom:32px;"></td>
                </tr>
              </table>

              <p style="margin:0 0 12px;font-family:'Courier New',monospace;font-size:15px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#3B82F6;">
                Sign in
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background-color:#1a1a1a;border:1px solid #2a2a2a;border-radius:3px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.08em;">
                      Email
                    </p>
                    <p style="margin:0 0 18px;font-family:'Courier New',monospace;font-size:14px;color:#ffffff;word-break:break-all;">
                      {username}
                    </p>
                    <p style="margin:0 0 6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.08em;">
                      Temporary password
                    </p>
                    <p style="margin:0;font-family:'Courier New',monospace;font-size:14px;color:#ffffff;word-break:break-all;">
                      {####}
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 32px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#555;">
                This temporary password expires in 7 days. You'll be prompted to set a permanent password on first sign-in.
              </p>

              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="background-color:#3B82F6;border-radius:2px;padding:14px 32px;">
                    <a href="${signInUrl}"
                      style="display:block;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:0.04em;color:#ffffff;text-decoration:none;">
                      Sign in to Pulp →
                    </a>
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:40px;">
                <tr>
                  <td style="border-top:1px solid #222;padding-bottom:32px;"></td>
                </tr>
              </table>

              <p style="margin:0 0 20px;font-family:'Courier New',monospace;font-size:15px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#3B82F6;">
                What you're testing
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td width="20" valign="top" style="padding:0 12px 20px 0;">
                    <span style="font-family:'Courier New',monospace;font-size:12px;color:#3B82F6;">01</span>
                  </td>
                  <td valign="top" style="padding-bottom:20px;">
                    <p style="margin:0 0 2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#f5f0e8;">
                      PDF → Summary
                    </p>
                    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#666;line-height:1.6;">
                      Upload any document and get a concise, structured summary in seconds.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td width="20" valign="top" style="padding:0 12px 20px 0;">
                    <span style="font-family:'Courier New',monospace;font-size:12px;color:#3B82F6;">02</span>
                  </td>
                  <td valign="top" style="padding-bottom:20px;">
                    <p style="margin:0 0 2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#f5f0e8;">
                      Auto-generated quizzes
                    </p>
                    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#666;line-height:1.6;">
                      Pulp pulls key concepts and turns them into testable questions automatically.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td width="20" valign="top" style="padding:0 12px 0 0;">
                    <span style="font-family:'Courier New',monospace;font-size:12px;color:#3B82F6;">03</span>
                  </td>
                  <td valign="top">
                    <p style="margin:0 0 2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#f5f0e8;">
                      Key term extraction
                    </p>
                    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#666;line-height:1.6;">
                      Surface the vocabulary that matters, extracted directly from your source material.
                    </p>
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:40px;">
                <tr>
                  <td style="border-top:1px solid #222;padding-bottom:28px;"></td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;color:#f5f0e8;font-weight:600;">
                Your feedback matters.
              </p>
              <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#666;line-height:1.6;">
                Reply directly to this email with any findings: bugs, confusing flows, or features you wish existed. Every note will get read.
              </p>

            </td>
          </tr>

          <tr>
            <td style="background-color:#0f0f0f;border-top:1px solid #1e1e1e;padding:24px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td>
                    <p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;color:#3a3a3a;line-height:1.6;">
                      You received this because you were invited to the Pulp beta.<br/>
                      Sent via Amazon SES
                    </p>
                  </td>
                  <td align="right">
                    <p style="margin:0;font-family:'Georgia',serif;font-size:18px;color:#2a2a2a;">
                      Pulp<span style="color:#3B82F6;">.</span>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}
