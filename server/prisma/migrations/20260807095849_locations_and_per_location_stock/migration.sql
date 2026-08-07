-- AlterTable
ALTER TABLE "users" ADD COLUMN     "location_id" UUID;

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_location_stock" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_location_stock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_name_key" ON "locations"("name");

-- CreateIndex
CREATE INDEX "product_location_stock_location_id_idx" ON "product_location_stock"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_location_stock_product_id_location_id_key" ON "product_location_stock"("product_id", "location_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_location_stock" ADD CONSTRAINT "product_location_stock_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_location_stock" ADD CONSTRAINT "product_location_stock_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data migration: every product's existing stock moves into one default location, so nothing
-- is lost when stock becomes per-location. The sum across locations still equals what
-- stock_quantity held. Existing callers get no location — an admin assigns one.
INSERT INTO "locations" ("id", "name", "updated_at")
VALUES (gen_random_uuid(), 'Main Store', CURRENT_TIMESTAMP);

INSERT INTO "product_location_stock" ("id", "product_id", "location_id", "quantity", "updated_at")
SELECT gen_random_uuid(),
       p."id",
       (SELECT "id" FROM "locations" WHERE "name" = 'Main Store'),
       p."stock_quantity",
       CURRENT_TIMESTAMP
FROM "products" p;
