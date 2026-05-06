import { PrismaClient } from "@prisma/client";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";

type UserProfile = {
    email: string;
    username: string;
    created_at: Date;
    refresh_token_expires_at: Date | null;
};

type OrderSummary = {
    order_id: string;
    event_name: string;
    event_description: string | null;
    event_date: Date;
    order_status: string;
    created_at: Date;
    seat_names: string[];
    total_price: number;
};

export class UserService {
    constructor(private readonly prisma: PrismaClient) { }

    async getProfile(user_id: string): Promise<UserProfile> {
        console.log('[getProfile] Verifying parameters');
        if (!user_id) {
            throw new ResourceNotFoundError("Invalid user_id provided.")
        }
        console.log('[getProfile] Parameters verified');
        
        console.log('[getProfile] Retrieving user');
        const user = await this.prisma.user.findUnique({
            where: { id: user_id },
            include: { refresh_token: true }
        });

        if (!user) {
            throw new ResourceNotFoundError("User not found.");
        }
        if (!user.refresh_token[0]) {
            throw new ResourceNotFoundError("Refresh token not found.");
        }
        console.log('[getProfile] Found user:', user.id);

        return {
            email: user.email,
            username: user.username,
            created_at: user.created_at,
            refresh_token_expires_at: user.refresh_token[0]?.expires_at ?? null,
        };
    }

    async getOrders(user_id: string): Promise<OrderSummary[]> {
        console.log('[getOrders] Verifying parameters');
        if (!user_id) {
            throw new ResourceNotFoundError("Invalid user_id provided.")
        }
        console.log('[getOrders] Parameters verified');

        console.log('[getOrders] Retrieving order');
        const orders = await this.prisma.order.findMany({
            where: { user_id: user_id },
            include: {
                order_seats: {
                    include: {
                        seat: {
                            include: { event: true }
                        }
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        console.log('[getOrders] Found', orders.length, 'orders.');

        return orders.map(order => {
            const seat_names = order.order_seats.map(os => `${os.seat.row}${os.seat.number}`);
            const total_price = order.order_seats.reduce((sum, os) => sum + os.price_at_purchase, 0);
            const event = order.order_seats[0]?.seat.event;

            return {
                order_id: order.id,
                event_name: event?.name ?? '',
                event_description: event?.description ?? null,
                event_date: event?.date ?? new Date(0),
                order_status: order.order_status,
                created_at: order.created_at,
                seat_names,
                total_price,
            };
        });
    }
}
