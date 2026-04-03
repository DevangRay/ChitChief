export const seatLockFromId = (seat_id: string) => `lock:seat:${seat_id}`;

export const seatIdFromLock = (lock_key: string) => lock_key.replace('lock:seat:', '');