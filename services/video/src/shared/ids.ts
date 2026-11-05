// Ids are UUIDv7 (time-ordered, ADR 0002): good B-tree locality and stable keyset order.
import { v7 } from 'uuid';

export const newId = (): string => v7();
