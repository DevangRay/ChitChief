import { Worker } from 'bullmq';
import { createPrismaClient } from './lib/prisma-factory';
import IORedis from 'ioredis';
import { OrderStatus, SeatStatus } from '@prisma/client';
import { seatLockFromId } from './lib/redis-keys';
import 'dotenv/config';
import { getDateForLogs } from './lib/date-formatter';
import { sendPostPaymentEmail } from './lib/send-email';

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
            console.log(`[worker: ${getDateForLogs()} | EXPIRE_SEAT_RESERVATION] Processing expire_seat_reservation job with data:`, job.data);
            const { seat_ids } = job.data;

            // set seat_status back to AVAILABLE for all seat_ids in job data
            const seat_update_result = await prisma.seat.updateMany({
                where: {
                    id: {
                        in: seat_ids
                    },
                    seat_status: SeatStatus.RESERVED
                },
                data: {
                    seat_status: SeatStatus.AVAILABLE
                }
            })
            console.log(`[worker: ${getDateForLogs()} | EXPIRE_SEAT_RESERVATION] Updated ${seat_update_result.count} seat(s) to AVAILABLE`);

            // delete redis locks for all seat_ids in job data
            const lock_keys = seat_ids.map((id: string) => seatLockFromId(id));
            // using pipeline instead of multi since we don't need atomicity. Will increase performance, and expiry is already set for keys
            let multi_chain = connection.pipeline();
            for (const key of lock_keys) {
                multi_chain = multi_chain.del(key);
            }
            await multi_chain.exec();

            console.log(`[worker: ${getDateForLogs()} | EXPIRE_SEAT_RESERVATION] Released locks and reset seat statuses for seat ids: ${seat_ids.join(', ')}`);
        } else if (job.name === 'expire_pending_order') {
            console.log(`[worker: ${getDateForLogs()} | EXPIRE_PENDING_ORDER] Processing expire_pending_order job with data:`, job.data);
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

                console.log(`[worker: ${getDateForLogs()} | EXPIRE_PENDING_ORDER] Set Order Status to EXPIRED and Deleted associated Order Seats for Order ID: ${order_id}`);
            } else {
                console.log(`[worker: ${getDateForLogs()} | EXPIRE_PENDING_ORDER] Order (${order_id}) was already handled.`);
            }
        } else if (job.name === "reset_successful_orders") {
            console.log(`[worker: ${getDateForLogs()} | RESET_SUCCESSFUL_ORDERS] Processing reset_successful_orders job with data:`, job.data);
            const { order_id } = job.data;

            // revert seat statuses from SOLD back to AVAILABLE
            const connected_seats = await prisma.orderSeats.findMany({
                where: {
                    order_id: order_id
                }
            });

            const seat_ids = connected_seats.map((os) => os.seat_id);
            console.log(`[worker: ${getDateForLogs()} | RESET_SUCCESSFUL_ORDERS] Updating seat_ids:`, seat_ids);

            await prisma.seat.updateMany({
                where: {
                    id: { in: seat_ids },
                    seat_status: SeatStatus.SOLD
                },
                data: { seat_status: SeatStatus.AVAILABLE }
            });

            // set order status to EXPIRED
            await prisma.order.update({
                where: {
                    id: order_id,
                    order_status: OrderStatus.CONFIRMED
                },
                data: { order_status: OrderStatus.EXPIRED }
            });

            console.log(`[worker: ${getDateForLogs()} | RESET_SUCCESSFUL_ORDERS] Reset Order ${order_id} to EXPIRED and set ${seat_ids.length} seat(s) to AVAILABLE.`);
        } else if (job.name === "send_success_message") {
            console.log(`[worker: ${getDateForLogs()} | SEND_SUCCESS_MESSAGE] Processing send_success_message job with data:`, job.data);
            const { email_target, order_id, event_name, seats } = job.data;

            console.log(`[worker: ${getDateForLogs()} | SEND_SUCCESS_MESSAGE] Sending success email to:`, email_target);

            const email_result = await sendPostPaymentEmail(true, email_target, order_id, event_name, seats);
            console.log(`[worker: ${getDateForLogs()} | SEND_SUCCESS_MESSAGE] Sent success email with result:`, email_result);
        } else if (job.name === "send_failure_message") {
            console.log(`[worker: ${getDateForLogs()} | SEND_FAILURE_MESSAGE] Processing send_failure_message job with data:`, job.data);
            const { email_target, order_id, event_name, seats } = job.data;

            console.log(`[worker: ${getDateForLogs()} | SEND_FAILURE_MESSAGE] Sending success email to:`, email_target);

            const email_result = await sendPostPaymentEmail(false, email_target, order_id, event_name, seats);
            console.log(`[worker: ${getDateForLogs()} | SEND_FAILURE_MESSAGE] Sent success email with result:`, email_result);
        }
    },
    { connection }
);

const shutdown = async () => {
    console.log(`[worker: ${getDateForLogs()} | SHUTDOWN] Shutting down gracefully...`)
    await worker.close()
    await prisma.$disconnect()
    await connection.quit()
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

worker.on('completed', (job) => {
    console.log(`[worker: ${getDateForLogs()} | COMPLETED] Job ${job.id}: "${job.name}" completed successfully`)
})

worker.on('failed', (job, err) => {
    console.error(`[worker: ${getDateForLogs()} | FAILURE] Job ${job?.id}: ${job?.name ? `"${job?.name}"` : ''} failed with error: ${err.message}. Full error:`, err);
})