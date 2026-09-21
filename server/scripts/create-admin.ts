import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function run() {
  const email = 'admin@gmail.com';
  const passwordHash = await bcrypt.hash('admin123', 10);
  
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      employeeId: 'EMP000',
      name: 'System Admin',
      email,
      phone: '9800000000',
      role: UserRole.admin,
      status: UserStatus.active,
      passwordHash,
    },
    update: {
      role: UserRole.admin,
      status: UserStatus.active,
      passwordHash,
      deletedAt: null,
    },
  });

  console.log('Admin user ready:', user.email, user.role, user.id);
  await prisma.$disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
