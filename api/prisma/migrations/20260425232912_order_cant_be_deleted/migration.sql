-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_stripe_payment_id_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_user_id_fkey";

-- AlterTable
ALTER TABLE "RefreshToken" ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '1 minute';

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_stripe_payment_id_fkey" FOREIGN KEY ("stripe_payment_id") REFERENCES "StripePaymentInfo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
