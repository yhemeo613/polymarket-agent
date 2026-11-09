import { envSchema } from '../src/config/env.schema';
import { AppConfigService } from '../src/config/app-config.service';
import { DbService } from '../src/db/db.service';

/** 构造真实 sqlite（:memory:）+ 真实配置的服务栈（集成不变量测试用） */
export function makeStack(envOverrides: Record<string, string> = {}) {
  const env = envSchema.parse({
    DB_PATH: ':memory:',
    KILL_SWITCH_PATH: './data/test-kill.switch',
    NODE_ENV: 'test',
    ...envOverrides,
  });
  const config = new AppConfigService(env);
  const db = new DbService(config);
  db.onModuleInit();
  return { config, db };
}
