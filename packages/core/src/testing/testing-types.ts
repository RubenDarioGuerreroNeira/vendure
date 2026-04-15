import { Mock } from 'vitest';

export type MockClass<T> = { [K in keyof T]: Mock<any> | any };
