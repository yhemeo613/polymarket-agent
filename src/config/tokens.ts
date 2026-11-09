/** DI token：zod 校验后的环境对象（独立文件避免循环依赖） */
export const ENV = Symbol('ENV_PARSED');
