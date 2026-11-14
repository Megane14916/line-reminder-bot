import { z } from 'zod'
import { ruleSchema, timeSchema } from './schedule'

const category = z.enum(['deadline', 'belonging'])
const title = z.string().trim().min(1).max(100).regex(/^[^\u0000\r\n]+$/)
const date = z.iso.date()
const target = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('name'), name: title, dueDate: date.optional() }),
  z.strictObject({ by: z.literal('id'), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ by: z.literal('recent') }),
])
const taskOperation = <const T extends string>(type: T) => z.strictObject({ type: z.literal(type), target })

export const intentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create_task'), title, dueDate: date, category, rule: ruleSchema.optional() }),
  z.strictObject({ type: z.literal('list_tasks'), category: category.optional(), from: date.optional(), to: date.optional(),
    status: z.enum(['open', 'done', 'deleted']).optional() }).refine((value) => !value.from || !value.to || value.from <= value.to),
  taskOperation('update_task').extend({ title: title.optional(), dueDate: date.optional(), category: category.optional() })
    .refine((value) => !!(value.title || value.dueDate || value.category)),
  taskOperation('complete_task'), taskOperation('reopen_task'), taskOperation('delete_task'), taskOperation('restore_task'),
  taskOperation('set_reminder').extend({ setting: z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('rule'), rule: ruleSchema }), z.strictObject({ by: z.literal('time'), time: timeSchema }),
  ]) }),
  taskOperation('disable_reminder'), taskOperation('enable_reminder'), taskOperation('get_reminder'),
  z.strictObject({ type: z.literal('set_group_default'), rule: ruleSchema }),
  z.strictObject({ type: z.literal('help') }), z.strictObject({ type: z.literal('clarify') }), z.strictObject({ type: z.literal('unknown') }),
])

export type TaskAction = z.infer<typeof intentSchema>
export type TargetAction = Extract<TaskAction, { target: unknown }>
