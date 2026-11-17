import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentActionMemoryTools } from '../../port/memory-port';
import { READ_MEMORY_FILE_KEY_PATTERN } from '../../tools/memory';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
} from '../../surface/family';

export { MEMORY_READ_ACTION_TYPES, MEMORY_WRITE_ACTION_TYPES } from './actions';
import {
  MEMORY_READ_ACTION_TYPES,
  MEMORY_WRITE_ACTION_TYPES,
  memoryActionSchema,
} from './actions';

/** Aliases dispatch the same validated tools and port as the named MCP tools. */
export function createMemoryActionFamily<H>(
  tools: AgentActionMemoryTools<H>,
): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'memory',
    types: [...MEMORY_READ_ACTION_TYPES, ...MEMORY_WRITE_ACTION_TYPES],
    actionSchema: memoryActionSchema,
    supportedTypes: () => [
      ...MEMORY_READ_ACTION_TYPES,
      ...MEMORY_WRITE_ACTION_TYPES,
    ],
    targetFields: [],
    catalog: (): readonly AgentActionCatalogEntry[] => [
      {
        type: 'memory.save',
        category: 'memory',
        summary: 'Save a durable fact as a pending synced note.',
        fields: [
          {
            name: 'scope',
            type: 'string',
            required: true,
            description: 'user or workspace memory.',
          },
          {
            name: 'text',
            type: 'string',
            required: true,
            description: 'The durable fact, at most 2,000 characters.',
          },
        ],
        example: {
          type: 'memory.save',
          scope: 'user',
          text: 'Use concise answers.',
        },
        keywords: ['memory', 'save', 'remember'],
      },
      {
        type: 'memory.search',
        category: 'memory',
        summary:
          'Search authorized synced memory, including server-retained historical notes.',
        fields: [
          {
            name: 'query',
            type: 'string',
            required: true,
            description: 'Search text, at most 1,000 characters.',
          },
          {
            name: 'cursor',
            type: 'string',
            required: false,
            description: 'Continuation from the same query.',
          },
        ],
        example: { type: 'memory.search', query: 'preferences' },
        keywords: ['memory', 'search', 'recall'],
      },
      {
        type: 'memory.read',
        category: 'memory',
        summary:
          'Read a bounded page of an exact search result. Desktop-only archives are unavailable.',
        fields: [
          {
            name: 'scope',
            type: 'string',
            required: true,
            description: 'The scope returned by search.',
          },
          {
            name: 'file',
            type: 'string',
            required: true,
            description: 'The exact opaque file key returned by search.',
          },
          {
            name: 'cursor',
            type: 'string',
            required: false,
            description: 'Continuation from the same entry.',
          },
        ],
        example: {
          type: 'memory.read',
          scope: 'user',
          file: 'inbox/cloud-key.md',
        },
        keywords: ['memory', 'read', 'recall'],
      },
    ],
    dispatchJsonSchema: {
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        query: { type: 'string', minLength: 1, maxLength: 1000 },
        scope: { type: 'string', enum: ['user', 'workspace'] },
        file: { type: 'string', pattern: READ_MEMORY_FILE_KEY_PATTERN.source },
        cursor: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      allOf: [
        {
          if: { properties: { type: { const: 'memory.save' } } },
          then: { required: ['scope', 'text'] },
        },
        {
          if: { properties: { type: { const: 'memory.search' } } },
          then: { required: ['query'] },
        },
        {
          if: { properties: { type: { const: 'memory.read' } } },
          then: { required: ['scope', 'file'] },
        },
      ],
    },
    dispatch: async (action, call) =>
      action.type === 'memory.save'
        ? tools.save({ scope: action.scope, text: action.text }, call)
        : action.type === 'memory.search'
          ? tools.search(
              {
                query: action.query,
                ...(action.cursor === undefined
                  ? {}
                  : { cursor: action.cursor }),
              },
              call,
            )
          : tools.read(
              {
                scope: action.scope,
                file: action.file,
                ...(action.cursor === undefined
                  ? {}
                  : { cursor: action.cursor }),
              },
              call,
            ),
  });
}
