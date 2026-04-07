/*
  Warnings:

  - You are about to drop the column `payment_id` on the `StripePaymentInfo` table. All the data in the column will be lost.
  - Made the column `stripe_payment_id` on table `Order` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `client_secret` to the `StripePaymentInfo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payment_intent_id` to the `StripePaymentInfo` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_stripe_payment_id_fkey";

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "stripe_payment_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "StripePaymentInfo" DROP COLUMN "payment_id",
ADD COLUMN     "client_secret" TEXT NOT NULL,
ADD COLUMN     "payment_intent_id" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_stripe_payment_id_fkey" FOREIGN KEY ("stripe_payment_id") REFERENCES "StripePaymentInfo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
