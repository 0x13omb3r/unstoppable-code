/** Tag before path redaction: bytecode uses flattened coordinates, fallback JS does not. */
function mainChunkId(filename: unknown): string | undefined {
  if (typeof filename !== 'string') return undefined;
  const path = filename.replace(/\\/g, '/');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path) && !path.startsWith('file://'))
    return undefined;
  if (/(^|\/)out\/main\/index\.jsc$/.test(path)) {
    return typeof __CANOPY_MAIN_BYTECODE_CHUNK_ID__ === 'string'
      ? __CANOPY_MAIN_BYTECODE_CHUNK_ID__ || undefined
      : undefined;
  }
  if (/(^|\/)out\/main\/_index\.js$/.test(path)) {
    return typeof __CANOPY_MAIN_FALLBACK_CHUNK_ID__ === 'string'
      ? __CANOPY_MAIN_FALLBACK_CHUNK_ID__ || undefined
      : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function tagMainExceptionFrames<
  T extends { properties?: Record<string, unknown> },
>(event: T): T {
  const exceptions = event.properties?.$exception_list;
  if (!Array.isArray(exceptions)) return event;
  return {
    ...event,
    properties: {
      ...event.properties,
      $exception_list: exceptions.map((exception: unknown) => {
        if (!isRecord(exception) || !isRecord(exception.stacktrace))
          return exception;
        const trace = exception.stacktrace;
        if (!Array.isArray(trace.frames)) return exception;
        return {
          ...exception,
          stacktrace: {
            ...trace,
            frames: trace.frames.map((frame: unknown) => {
              if (!isRecord(frame)) return frame;
              const id = mainChunkId(frame.filename ?? frame.abs_path);
              return id ? { ...frame, chunk_id: id } : frame;
            }),
          },
        };
      }),
    },
  };
}
