// Cognito CustomMessage trigger — renders the Pulp welcome email for
// AdminCreateUser. Other trigger sources fall through to Cognito's defaults.

import type { CustomMessageTriggerEvent } from 'aws-lambda';
import { renderWelcomeEmail, WELCOME_EMAIL_SUBJECT } from './welcome-email-template';

const SIGN_IN_URL = process.env.SIGN_IN_URL!;

export async function handler(event: CustomMessageTriggerEvent): Promise<CustomMessageTriggerEvent> {
  if (event.triggerSource === 'CustomMessage_AdminCreateUser') {
    event.response.emailSubject = WELCOME_EMAIL_SUBJECT;
    event.response.emailMessage = renderWelcomeEmail({ signInUrl: SIGN_IN_URL });
  }
  return event;
}
