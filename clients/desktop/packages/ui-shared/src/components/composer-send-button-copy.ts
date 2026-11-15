/**
 * What the composer's Stop says once its stop is sent, on every host that
 * renders `ComposerSendButton`.
 */

/** A stop is sent and the turn hasn't ended yet. */
export const COMPOSER_STOPPING_LABEL = 'Stopping…';

/**
 * A cloud turn's stop is accepted while the turn is still starting and the
 * project's sandbox is asleep or waking: Core ends the turn only once it
 * wakes (CAN-6721, CAN-6766).
 */
export const COMPOSER_STOPPING_WAITING_FOR_WAKE_LABEL =
  'Stopping… waiting for the project to wake';
