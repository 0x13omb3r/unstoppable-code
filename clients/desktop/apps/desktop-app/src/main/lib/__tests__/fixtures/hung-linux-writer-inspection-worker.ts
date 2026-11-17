// A writer inspection that never answers (CAN-6899): the app must refuse the
// removal as incomplete rather than wait for it or treat silence as success.
setInterval(() => undefined, 1_000);
