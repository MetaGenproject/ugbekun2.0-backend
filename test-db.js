require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Connecting to database...");
  try {
    const userCount = await prisma.user.count();
    console.log(`Total users in DB: ${userCount}`);
    
    // Check if master (Superadmin) user exists
    const masterUser = await prisma.user.findUnique({
      where: { username: 'master' }
    });

    if (!masterUser) {
      console.log("No 'master' user found. Creating default Superadmin account...");
      const hashedPassword = await bcrypt.hash('master123', 10);
      const newMaster = await prisma.user.create({
        data: {
          id: 9999,
          username: 'master',
          password: hashedPassword,
          role: 1, // Role 1 = Superadmin (Master) — only 1 globally
          active: true
        }
      });
      console.log("Default Superadmin account created:", newMaster);
    }

    // Check if admin user exists
    const adminUser = await prisma.user.findUnique({
      where: { username: 'admin' }
    });

    if (!adminUser) {
      console.log("No 'admin' user found. Creating default Branch Admin account...");
      const hashedPassword = await bcrypt.hash('admin123', 10);
      const newAdmin = await prisma.user.create({
        data: {
          id: 9998,
          username: 'admin',
          password: hashedPassword,
          role: 2, // Role 2 = Branch Admin (per school)
          active: true
        }
      });
      console.log("Default Branch Admin account created:", newAdmin);
    }

    // Check if a teacher user exists
    const teacherUser = await prisma.user.findUnique({
      where: { username: 'teacher' }
    });

    if (!teacherUser) {
      console.log("No 'teacher' user found. Creating default teacher account...");
      const hashedPassword = await bcrypt.hash('teacher123', 10);
      const newTeacher = await prisma.user.create({
        data: {
          id: 2,
          username: 'teacher',
          password: hashedPassword,
          role: 3, // Teacher role
          active: true
        }
      });
      console.log("Default teacher account created successfully:", newTeacher);
    }

    // Check if student user exists
    const studentUser = await prisma.user.findUnique({
      where: { username: 'student' }
    });

    if (!studentUser) {
      console.log("No 'student' user found. Creating default student account...");
      const hashedPassword = await bcrypt.hash('student123', 10);
      const newStudent = await prisma.user.create({
        data: {
          id: 3,
          username: 'student',
          password: hashedPassword,
          role: 7, // Student role
          active: true
        }
      });
      console.log("Default student account created successfully:", newStudent);
    }

    // Check if parent user exists
    const parentUser = await prisma.user.findUnique({
      where: { username: 'parent' }
    });

    if (!parentUser) {
      console.log("No 'parent' user found. Creating default parent account...");
      const hashedPassword = await bcrypt.hash('parent123', 10);
      const newParent = await prisma.user.create({
        data: {
          id: 5,
          username: 'parent',
          password: hashedPassword,
          role: 6, // Parent role
          active: true
        }
      });
      console.log("Default parent account created successfully:", newParent);
    } else {
      console.log("Parent user already exists:", {
        id: parentUser.id,
        username: parentUser.username,
        role: parentUser.role,
        active: parentUser.active
      });
    }

  } catch (err) {
    console.error("Error connecting or seeding DB:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
