/** /api/v1 的 OpenAPI 3.0 契约描述（fixture 同步断言其覆盖 submit/status/result/import） */

const idempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: '写操作幂等键：同 key 同 body 重放首次结果，同 key 不同 body 返回 409；最长 200 字符，超长返回 400',
  schema: { type: 'string', maxLength: 200 },
}

function v1ErrorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  }
}

export const v1OpenApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'BibiGPT v1 API (self-hosted)',
    version: '1.0.0',
    description:
      '为浏览器扩展、iOS 快捷方式与未来客户端提供版本化、异步、可轮询的稳定 API。自用版：无任何订阅/支付/额度概念，超额仅体现为 rate limit。',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'v1 API token（scope: read | write，可撤销）' },
    },
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: [
                  'INVALID_REQUEST',
                  'UNAUTHORIZED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'UNSUPPORTED_SOURCE',
                  'IDEMPOTENCY_CONFLICT',
                  'RATE_LIMITED',
                  'NO_TRANSCRIPT',
                  'SOURCE_UNAVAILABLE',
                  'UPSTREAM_TIMEOUT',
                  'INTERNAL',
                ],
              },
              message: { type: 'string' },
              details: {},
            },
            required: ['code', 'message'],
          },
        },
        required: ['error'],
      },
      JobStatus: {
        type: 'string',
        enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
      },
      JobError: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' }, stepIndex: { type: 'integer' } },
        required: ['code', 'message'],
      },
      TranscriptSegment: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          text: { type: 'string' },
          lang: { type: 'string' },
          speaker: { type: 'string' },
          sourceRef: { type: 'string' },
        },
        required: ['start', 'end', 'text'],
      },
      SubmitRequest: {
        type: 'object',
        properties: {
          sourceUrl: { type: 'string', description: 'youtube/bilibili 视频页 URL' },
          options: {
            type: 'object',
            properties: { model: { type: 'string' }, language: { type: 'string' } },
          },
        },
        required: ['sourceUrl'],
      },
      SubmitResponse: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          contentId: { type: 'string', nullable: true },
          reused: { type: 'boolean', description: '命中已存在（未完成或已完成）的 job 时为 true' },
        },
        required: ['jobId', 'contentId', 'reused'],
      },
      ImportRequest: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          target: { type: 'string', enum: ['watch-later'] },
        },
        required: ['urls', 'target'],
      },
      ImportResponse: {
        type: 'object',
        properties: {
          imported: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceUrl: { type: 'string' },
                contentId: { type: 'string', nullable: true },
                service: { type: 'string' },
              },
              required: ['sourceUrl', 'contentId'],
            },
          },
          duplicates: { type: 'array', items: { type: 'string' } },
        },
        required: ['imported', 'duplicates'],
      },
    },
    responses: {
      InvalidRequest: v1ErrorResponse('Invalid request'),
      Unauthorized: v1ErrorResponse('Unauthorized'),
      Forbidden: v1ErrorResponse('Forbidden'),
    },
  },
  paths: {
    '/submit': {
      post: {
        summary: '提交摘要任务（异步）',
        description:
          '入队即返回 202，轮询 GET /jobs/{jobId}。支持 Idempotency-Key 头：重复提交同 key 同 body 返回首次结果。导入/提交本身不会同步阻塞到摘要完成。',
        parameters: [idempotencyKeyParam],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitRequest' } } } },
        responses: {
          '202': {
            description: '已入队',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResponse' } } },
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': {
            description: 'Idempotency 冲突',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          '422': {
            description: '不支持的来源域名',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          '429': {
            description: 'Rate limited',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          '501': {
            description: 'No transcript',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        },
      },
    },
    '/import': {
      post: {
        summary: '批量导入 URL 到 Watch Later（绝不触发摘要）',
        parameters: [idempotencyKeyParam],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportRequest' } } } },
        responses: {
          '200': {
            description: '导入结果（含去重）',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportResponse' } } },
          },
          '400': { $ref: '#/components/responses/InvalidRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '422': {
            description: '含不支持 URL（details.unsupported 列出）',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
          '429': {
            description: 'Rate limited',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        },
      },
    },
    '/jobs/{id}': {
      get: {
        summary: '查询 job 状态',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'job 状态（contentId 为扩展字段：已落库内容 id）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jobId: { type: 'string' },
                    status: { $ref: '#/components/schemas/JobStatus' },
                    error: { $ref: '#/components/schemas/JobError' },
                    contentId: { type: 'string', nullable: true },
                  },
                  required: ['jobId', 'status', 'error'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': {
            description: 'Job 未找到',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        },
      },
    },
    '/contents/{contentId}': {
      get: {
        summary: '读取摘要结果',
        parameters: [
          { name: 'contentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          {
            name: 'artifact',
            in: 'query',
            schema: { type: 'string', enum: ['1'] },
            description: '附带 ArtifactBundle（章节/重点/关键词/大纲/transcript）',
          },
        ],
        responses: {
          '200': {
            description: '内容与最新摘要',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    contentId: { type: 'string' },
                    title: { type: 'string', nullable: true },
                    sourceUrl: { type: 'string' },
                    summaryText: { type: 'string', nullable: true },
                    artifact: { type: 'object', nullable: true },
                  },
                  required: ['contentId', 'title', 'sourceUrl', 'summaryText'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': {
            description: '内容未找到',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        },
      },
    },
    '/contents/{contentId}/transcript': {
      get: {
        summary: '读取字幕分段',
        parameters: [{ name: 'contentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: '字幕分段（跟随最新 summary 的 transcript）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    lang: { type: 'string', nullable: true },
                    segments: { type: 'array', items: { $ref: '#/components/schemas/TranscriptSegment' } },
                  },
                  required: ['lang', 'segments'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': {
            description: '内容未找到',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        },
      },
    },
    '/watch-later': {
      get: {
        summary: 'Watch Later 列表（游标分页）',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: '上一页响应返回的 cursor' },
        ],
        responses: {
          '200': {
            description: 'items + 下一页游标（有更多时返回）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { type: 'object' } },
                    cursor: { type: 'string' },
                    collection: { type: 'object' },
                  },
                  required: ['items'],
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/admin/tokens': {
      post: {
        summary: '新建 API token（管理面，x-admin-token 鉴权）',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  scope: { type: 'string', enum: ['read', 'write'] },
                  userId: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                },
                required: ['scope'],
              },
            },
          },
        },
        responses: {
          '201': { description: '明文 token 只在此响应返回一次' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: '未配置 BIBI_V1_ADMIN_TOKEN 时管理面禁用' },
        },
      },
      get: {
        summary: '列出 API token（不含哈希/明文）',
        responses: { '200': { description: 'token 列表' } },
      },
    },
    '/admin/tokens/{tokenId}': {
      delete: {
        summary: '撤销 API token',
        parameters: [{ name: 'tokenId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: '已撤销' },
          '404': { description: 'Token 未找到' },
        },
      },
    },
  },
}
