import { Worker } from 'bullmq';
import { createPrismaClient } from './lib/prisma-factory';
import IORedis from 'ioredis';
import { OrderStatus, SeatStatus } from '@prisma/client';
import { seatLockFromId } from './lib/redis-keys';
import 'dotenv/config';
import { getDateForLogs } from './lib/date-formatter';

const connection = new IORedis(
    process.env.REDIS_URL!,
    {
        maxRetriesPerRequest: null, // Required for BullMQ
    });
const prisma = createPrismaClient(process.env.DATABASE_URL!);

const worker = new Worker(
    'reservations',
    async (job) => {
        if (job.name === 'expire_seat_reservation') {
            console.log(`[worker: ${getDateForLogs()}] Processing expire_seat_reservation job with data:`, job.data);
            const { seat_ids } = job.data;

            // set seat_status back to AVAILABLE for all seat_ids in job data
            await prisma.seat.updateMany({
                where: {
                    id: {
                        in: seat_ids
                    },
                    seat_status: SeatStatus.RESERVED
                },
                data: {
                    seat_status: 'AVAILABLE'
                }
            })

            // delete redis locks for all seat_ids in job data
            const lock_keys = seat_ids.map((id: string) => seatLockFromId(id));
            // using pipeline instead of multi since we don't need atomicity. Will increase performance, and expiry is already set for keys
            let multi_chain = connection.pipeline();
            for (const key of lock_keys) {
                multi_chain = multi_chain.del(key);
            }
            await multi_chain.exec();

            console.log(`[worker: ${getDateForLogs()}] Released locks and reset seat statuses for seat ids: ${seat_ids.join(', ')}`);
        } else if (job.name === 'expire_pending_order') {
            console.log(`[worker: ${getDateForLogs()}] Processing expire_pending_order job with data:`, job.data);
            const { order_id } = job.data;

            const target_order = await prisma.order.findUnique({
                where: {
                    id: order_id,
                    order_status: OrderStatus.PENDING
                }
            })

            if (target_order) {
                await prisma.order.update({
                    where: {
                        id: order_id
                    },
                    data: {
                        order_status: OrderStatus.EXPIRED
                    }
                });

                await prisma.orderSeats.deleteMany({
                    where: {
                        order_id: order_id
                    }
                });

                console.log(`[worker: ${getDateForLogs()}] Set Order Status to EXPIRED and Deleted associated Order Seats for Order ID: ${order_id}`);
            } else {
                console.log(`[worker: ${getDateForLogs()}] Order was already handled: ${order_id}`);
            }

        }
    },
    { connection }
);

const shutdown = async () => {
    console.log(`[worker: ${getDateForLogs()}] Shutting down gracefully...`)
    await worker.close()
    await prisma.$disconnect()
    await connection.quit()
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

worker.on('completed', (job) => {
    console.log(`[worker: ${getDateForLogs()}] Job ${job.id}: "${job.name}" completed successfully`)
})

worker.on('failed', (job, err) => {
    console.error(`[worker: ${getDateForLogs()}] Job ${job?.id}: ${job?.name ? "${job?.name}" : ''} failed with error: ${err.message}. Full error:`, err);
})