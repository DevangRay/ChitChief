-- CreateIndex
CREATE INDEX "Order_order_status_created_at_idx" ON "Order"("order_status", "created_at");
