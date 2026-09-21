import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  console.log('Cleaning database while preserving admin@gmail.com...');

  // Ensure admin@gmail.com exists
  const admin = await prisma.user.findUnique({
    where: { email: 'admin@gmail.com' },
  });

  if (!admin) {
    throw new Error('admin@gmail.com not found!');
  }

  console.log(`Preserving Admin: ${admin.email} (ID: ${admin.id})`);

  // Transactionally clear all data
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.leadActivity.deleteMany(),
    prisma.leadAssignment.deleteMany(),
    prisma.leadMedicine.deleteMany(),
    prisma.followUp.deleteMany(),
    prisma.renewal.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.lead.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.session.deleteMany(),
    prisma.user.deleteMany({
      where: {
        email: { not: 'admin@gmail.com' },
      },
    }),
    prisma.user.update({
      where: { email: 'admin@gmail.com' },
      data: {
        assignedLeadsCount: 0,
        status: 'active',
        role: 'admin',
      },
    }),
  ]);

  try {
    await prisma.$executeRawUnsafe('ALTER SEQUENCE order_number_seq RESTART WITH 1;');
  } catch (e) {
    console.log('Sequence reset notice:', e);
  }

  const [usersCount, leadsCount, ordersCount, renewalsCount, followUpsCount, customersCount, auditCount] =
    await Promise.all([
      prisma.user.count(),
      prisma.lead.count(),
      prisma.order.count(),
      prisma.renewal.count(),
      prisma.followUp.count(),
      prisma.customer.count(),
      prisma.auditLog.count(),
    ]);

  console.log('Clean complete. Current table counts:', {
    users: usersCount,
    leads: leadsCount,
    orders: ordersCount,
    renewals: renewalsCount,
    followUps: followUpsCount,
    customers: customersCount,
    auditLogs: auditCount,
  });

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Clean failed:', e);
  process.exit(1);
});
