import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler'
import initial from '../migrations/0001_init.sql?raw'
import batches from '../migrations/0002_notification_batches.sql?raw'
import retries from '../migrations/0003_notification_retries.sql?raw'
import natural from '../migrations/0004_natural_language_reminders.sql?raw'

export async function testPlatform() {
  const platform = await getPlatformProxy<Env>({ persist: false, remoteBindings: false, envFiles: [] })
  const { DB } = platform.env
  try {
    for (const migration of [initial, batches, retries, natural]) {
      await DB.batch(unstable_splitSqlQuery(migration).map((sql) => DB.prepare(sql)))
    }
    return platform
  } catch (error) {
    await platform.dispose()
    throw error
  }
}
