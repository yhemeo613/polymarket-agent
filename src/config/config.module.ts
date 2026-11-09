import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';
import { AppConfigService } from './app-config.service';
import { ENV } from './tokens';

export { ENV };

/**
 * 全局配置模块：加载 .env → zod 校验 → 提供 AppConfigService。
 * 非法配置直接启动失败（fail-fast）。
 */
@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] })],
  providers: [
    {
      provide: ENV,
      useFactory: (): EnvLike => {
        const parsed = envSchema.safeParse(process.env);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          throw new Error(`环境配置校验失败 → ${issues}`);
        }
        return parsed.data;
      },
    },
    AppConfigService,
  ],
  exports: [AppConfigService, ENV],
})
export class AppConfigModule {}

export type EnvLike = ReturnType<typeof envSchema.parse>;
