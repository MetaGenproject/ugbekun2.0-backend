import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';
import { uploadToCloudinary } from '../../lib/cloudinaryService';
import {
  getMyEduRideConfig,
  saveMyEduRideConfig,
  testMyEduRideConnection,
  syncStudentsToMyEduRide,
  getTransportOverview,
  getBusFleet,
  getGateLogs,
  processGateScan,
  updateStudentBoarding,
  exportGateLogsCsv,
  exportGateLogsPdf,
} from '../../lib/myedurideBridgeService';
import {
  getOrCreateLandingPage,
  formatLandingPageResponse,
} from '../../lib/schoolCmsService';
import {
  generateDomainVerificationToken,
  verifyDomainDns,
  formatDomainSlug,
  DEFAULT_DNS_TARGET,
} from '../../lib/domainService';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here_change_in_production';

// ============================================================================
// EVENTS MANAGEMENT
// ============================================================================

/**
 * GET /api/admin/events
 */
export async function getEvents(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const events = await prisma.event.findMany({
      where: {
        branchId,
        sessionId,
      },
      orderBy: {
        startDate: 'asc',
      },
    });

    return res.json({ success: true, events });
  } catch (error: any) {
    console.error('[ADMIN] Get events error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch events.' });
  }
}

/**
 * POST /api/admin/events
 */
export async function createEvent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { title, description, startDate, endDate } = req.body;

  if (!title || !startDate) {
    return res.status(400).json({ success: false, message: 'Title and Start Date are required.' });
  }

  try {
    const globalSetting = await prisma.globalSettings.findFirst();
    const sessionId = globalSetting?.sessionId || 5;

    const newEvent = await prisma.event.create({
      data: {
        title,
        description,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        branchId,
        sessionId,
      },
    });

    return res.json({ success: true, event: newEvent, message: 'Event created successfully!' });
  } catch (error: any) {
    console.error('[ADMIN] Create event error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create event.' });
  }
}

/**
 * PUT /api/admin/events/:id
 */
export async function updateEvent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const eventId = Number(req.params.id);
  const { title, description, startDate, endDate } = req.body;

  try {
    const existing = await prisma.event.findFirst({
      where: {
        id: eventId,
        branchId,
      },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Event not found or unauthorized.' });
    }

    const updated = await prisma.event.update({
      where: { id: eventId },
      data: {
        title: title !== undefined ? title : existing.title,
        description: description !== undefined ? description : existing.description,
        startDate: startDate ? new Date(startDate) : existing.startDate,
        endDate: endDate !== undefined ? (endDate ? new Date(endDate) : null) : existing.endDate,
      },
    });

    return res.json({ success: true, event: updated, message: 'Event updated successfully!' });
  } catch (error: any) {
    console.error('[ADMIN] Update event error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update event.' });
  }
}

/**
 * DELETE /api/admin/events/:id
 */
export async function deleteEvent(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const eventId = Number(req.params.id);

  try {
    const existing = await prisma.event.findFirst({
      where: {
        id: eventId,
        branchId,
      },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Event not found or unauthorized.' });
    }

    await prisma.event.delete({
      where: { id: eventId },
    });

    return res.json({ success: true, message: 'Event deleted successfully!' });
  } catch (error: any) {
    console.error('[ADMIN] Delete event error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete event.' });
  }
}

// ============================================================================
// SYSTEM SETTINGS & BRANDING
// ============================================================================

/**
 * GET /api/admin/settings
 */
export async function getSettings(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    let settings = await prisma.systemSetting.findUnique({
      where: { branchId },
    });

    if (!settings) {
      settings = await prisma.systemSetting.create({
        data: {
          branchId,
        },
      });
    }

    return res.json({ success: true, data: settings });
  } catch (error: any) {
    console.error('[SETTINGS] Fetch settings error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch settings.' });
  }
}

/**
 * POST /api/admin/settings
 */
export async function updateSettings(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      schoolName,
      tagline,
      address,
      phone,
      email,
      website,
      logoUrl,
      principalSignatureUrl,
      currencySymbol,
      academicSession,
      currentTerm,
      regNoPrefix,
      regNoDigits,
      defaultStudentPassword,
      autoSmsAttendance,
      maxAbsentDaysAlert,
      idCardTheme,
      maintenanceMode,
      aiAssistanceEnabled,
      notificationChannel,
      timezone,
      dateFormat,
      weeklyMintLimit,
    } = req.body;

    const updated = await prisma.systemSetting.upsert({
      where: { branchId },
      update: {
        ...(schoolName !== undefined && { schoolName }),
        ...(tagline !== undefined && { tagline }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(website !== undefined && { website }),
        ...(logoUrl !== undefined && { logoUrl }),
        ...(principalSignatureUrl !== undefined && { principalSignatureUrl }),
        ...(currencySymbol !== undefined && { currencySymbol }),
        ...(academicSession !== undefined && { academicSession }),
        ...(currentTerm !== undefined && { currentTerm }),
        ...(regNoPrefix !== undefined && { regNoPrefix }),
        ...(regNoDigits !== undefined && { regNoDigits: parseInt(regNoDigits, 10) }),
        ...(defaultStudentPassword !== undefined && { defaultStudentPassword }),
        ...(autoSmsAttendance !== undefined && { autoSmsAttendance: Boolean(autoSmsAttendance) }),
        ...(maxAbsentDaysAlert !== undefined && { maxAbsentDaysAlert: parseInt(maxAbsentDaysAlert, 10) }),
        ...(idCardTheme !== undefined && { idCardTheme }),
        ...(maintenanceMode !== undefined && { maintenanceMode: Boolean(maintenanceMode) }),
        ...(aiAssistanceEnabled !== undefined && { aiAssistanceEnabled: Boolean(aiAssistanceEnabled) }),
        ...(notificationChannel !== undefined && { notificationChannel }),
        ...(timezone !== undefined && { timezone }),
        ...(dateFormat !== undefined && { dateFormat }),
        ...(weeklyMintLimit !== undefined && { weeklyMintLimit: parseInt(weeklyMintLimit, 10) }),
        updatedAt: new Date(),
      },
      create: {
        branchId: branchId!,
        schoolName: schoolName || 'Ugbekun International Academy',
        tagline: tagline || 'Excellence in Knowledge & Character',
        address: address || '',
        phone: phone || '+234 800 000 0000',
        email: email || 'info@ugbekun.edu.ng',
        website: website || 'https://ugbekun.edu.ng',
        logoUrl: logoUrl || null,
        principalSignatureUrl: principalSignatureUrl || null,
        currencySymbol: currencySymbol || '₦',
        academicSession: academicSession || '2025/2026',
        currentTerm: currentTerm || 'First Term',
        regNoPrefix: regNoPrefix || 'UGB',
        regNoDigits: regNoDigits ? parseInt(regNoDigits, 10) : 4,
        defaultStudentPassword: defaultStudentPassword || 'student123',
        autoSmsAttendance: autoSmsAttendance !== undefined ? Boolean(autoSmsAttendance) : true,
        maxAbsentDaysAlert: maxAbsentDaysAlert ? parseInt(maxAbsentDaysAlert, 10) : 3,
        idCardTheme: idCardTheme || 'EMERALD_MODERN',
        maintenanceMode: maintenanceMode !== undefined ? Boolean(maintenanceMode) : false,
        aiAssistanceEnabled: aiAssistanceEnabled !== undefined ? Boolean(aiAssistanceEnabled) : true,
        notificationChannel: notificationChannel || 'ALL',
        timezone: timezone || 'Africa/Lagos',
        dateFormat: dateFormat || 'DD/MM/YYYY',
        weeklyMintLimit: weeklyMintLimit ? parseInt(weeklyMintLimit, 10) : 5000,
      },
    });

    if (schoolName) {
      await prisma.branch
        .update({
          where: { id: branchId },
          data: { name: schoolName },
        })
        .catch(() => {});
    }

    return res.json({ success: true, message: 'System settings updated successfully.', data: updated });
  } catch (error: any) {
    console.error('[SETTINGS] Save settings error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save system settings.' });
  }
}

/**
 * POST /api/admin/settings/upload-logo
 */
export async function uploadLogo(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  try {
    const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, {
      folder: `ugbekun_branch_${branchId}_branding`,
      public_id: `school_asset_${Date.now()}`,
    });

    return res.json({
      success: true,
      message: 'Image uploaded successfully to Cloudinary.',
      url: cloudinaryUrl,
    });
  } catch (error) {
    console.error('[SETTINGS] Cloudinary upload error:', error);
    try {
      const uploadDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const ext = path.extname(req.file.originalname) || '.png';
      const filename = `school_asset_${branchId}_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
      return res.json({
        success: true,
        message: 'Image uploaded locally.',
        url: `/uploads/${filename}`,
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: (error as any).message || 'Failed to upload image.' });
    }
  }
}

/**
 * GET /api/admin/school-info
 */
export async function getSchoolInfo(req: Request, res: Response): Promise<Response | void> {
  try {
    let branchId = req.branchId || 1;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true },
    });

    const settings = branch?.systemSetting;
    return res.json({
      success: true,
      data: {
        schoolName: settings?.schoolName || branch?.name || 'Ugbekun International Academy',
        logoUrl: settings?.logoUrl || null,
        academicSession: settings?.academicSession || '2025/2026',
        currentTerm: settings?.currentTerm || 'First Term',
        currencySymbol: settings?.currencySymbol || '₦',
      },
    });
  } catch (error) {
    console.error('[SCHOOL INFO] Error:', error);
    return res.json({
      success: true,
      data: {
        schoolName: 'Ugbekun International Academy',
        logoUrl: null,
        academicSession: '2025/2026',
        currentTerm: 'First Term',
        currencySymbol: '₦',
      },
    });
  }
}

/**
 * POST /api/admin/profile/upload-photo
 */
export async function uploadAdminPhoto(req: Request, res: Response): Promise<Response | void> {
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No photo file provided.' });
  }

  try {
    const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, {
      folder: `ugbekun_user_profiles`,
      public_id: `profile_photo_user_${userId}_${Date.now()}`,
    });

    await prisma.user
      .update({
        where: { id: userId },
        data: { photo: cloudinaryUrl },
      })
      .catch(() => {});

    return res.json({
      success: true,
      message: 'Profile photo uploaded to Cloudinary & active across ID cards, report cards, and certificates!',
      photoUrl: cloudinaryUrl,
    });
  } catch (error: any) {
    console.error('[PROFILE] Photo upload error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload profile photo.' });
  }
}

// ============================================================================
// INVENTORY MANAGEMENT
// ============================================================================

/**
 * GET /api/admin/inventory
 */
export async function getInventory(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { category, search } = (req.query || {}) as any;

    const where: any = { branchId };
    if (category && category !== 'All') {
      where.category = category;
    }
    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { category: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const [items, transactions] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.inventoryTransaction.findMany({
        where: { item: { branchId } },
        include: { item: { select: { name: true, category: true, unit: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    let totalItemsCount = items.length;
    let totalPurchasedQty = 0;
    let totalSoldQty = 0;
    let totalBalanceQty = 0;
    let totalPurchasedAmount = 0;
    let totalSalesAmount = 0;
    let lowStockCount = 0;

    items.forEach((item) => {
      totalPurchasedQty += item.totalPurchasedInt;
      totalSoldQty += item.totalSoldInt;
      totalBalanceQty += item.quantityBalance;
      totalPurchasedAmount += item.totalPurchasedInt * item.unitCost;
      totalSalesAmount += item.totalSoldInt * item.unitPrice;
      if (item.quantityBalance <= item.reorderLevel) {
        lowStockCount++;
      }
    });

    return res.json({
      success: true,
      data: {
        metrics: {
          totalItemsCount,
          totalPurchasedQty,
          totalSoldQty,
          totalBalanceQty,
          totalPurchasedAmount,
          totalSalesAmount,
          lowStockCount,
        },
        items,
        recentTransactions: transactions.map((t) => ({
          id: t.id,
          itemId: t.itemId,
          itemName: t.item.name,
          category: t.item.category,
          unit: t.item.unit,
          type: t.type,
          quantity: t.quantity,
          unitPrice: t.unitPrice,
          totalAmount: t.totalAmount,
          referenceNo: t.referenceNo,
          notes: t.notes,
          issuedTo: t.issuedTo,
          createdAt: t.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('[INVENTORY] Fetch error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch inventory records.' });
  }
}

/**
 * POST /api/admin/inventory/items
 */
export async function createInventoryItem(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { name, category, unit, unitCost, unitPrice, initialStock, reorderLevel } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Item name is required.' });
    }

    const cost = parseFloat(unitCost) || 0.0;
    const price = parseFloat(unitPrice) || 0.0;
    const qty = parseInt(initialStock, 10) || 0;
    const alertLevel = parseInt(reorderLevel, 10) || 5;

    const newItem = await prisma.inventoryItem.create({
      data: {
        branchId: branchId!,
        name: name.trim(),
        category: category || 'General',
        unit: unit || 'Pcs',
        unitCost: cost,
        unitPrice: price,
        totalPurchasedInt: qty,
        totalSoldInt: 0,
        quantityBalance: qty,
        reorderLevel: alertLevel,
      },
    });

    if (qty > 0) {
      await prisma.inventoryTransaction.create({
        data: {
          itemId: newItem.id,
          type: 'PURCHASE',
          quantity: qty,
          unitPrice: cost,
          totalAmount: qty * cost,
          referenceNo: `INIT-${newItem.id}`,
          notes: 'Initial Stock Entry',
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Inventory item created successfully.',
      item: newItem,
    });
  } catch (error: any) {
    console.error('[INVENTORY] Create item error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create inventory item.' });
  }
}

/**
 * POST /api/admin/inventory/purchase
 */
export async function recordInventoryPurchase(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { itemId, quantity, unitCost, referenceNo, notes } = req.body;

    const qty = parseInt(quantity, 10);
    if (!itemId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Valid item and positive purchase quantity are required.' });
    }

    const item = await prisma.inventoryItem.findFirst({
      where: { id: parseInt(itemId, 10), branchId },
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }

    const cost =
      parseFloat(unitCost) !== undefined && !isNaN(parseFloat(unitCost)) ? parseFloat(unitCost) : item.unitCost;
    const totalAmount = qty * cost;

    const [updatedItem, transaction] = await prisma.$transaction([
      prisma.inventoryItem.update({
        where: { id: item.id },
        data: {
          totalPurchasedInt: { increment: qty },
          quantityBalance: { increment: qty },
          unitCost: cost,
        },
      }),
      prisma.inventoryTransaction.create({
        data: {
          itemId: item.id,
          type: 'PURCHASE',
          quantity: qty,
          unitPrice: cost,
          totalAmount,
          referenceNo: referenceNo || `PUR-${Date.now()}`,
          notes: notes || null,
        },
      }),
    ]);

    return res.json({
      success: true,
      message: `Successfully restocked ${qty} ${item.unit} of ${item.name}.`,
      item: updatedItem,
      transaction,
    });
  } catch (error: any) {
    console.error('[INVENTORY] Purchase error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record stock purchase.' });
  }
}

/**
 * POST /api/admin/inventory/sale
 */
export async function recordInventorySale(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { itemId, quantity, unitPrice, referenceNo, issuedTo, notes } = req.body;

    const qty = parseInt(quantity, 10);
    if (!itemId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Valid item and positive sale quantity are required.' });
    }

    const item = await prisma.inventoryItem.findFirst({
      where: { id: parseInt(itemId, 10), branchId },
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }

    if (item.quantityBalance < qty) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock! Balance is ${item.quantityBalance} ${item.unit}, but attempted to sell/issue ${qty} ${item.unit}.`,
      });
    }

    const price =
      parseFloat(unitPrice) !== undefined && !isNaN(parseFloat(unitPrice)) ? parseFloat(unitPrice) : item.unitPrice;
    const totalAmount = qty * price;

    const [updatedItem, transaction] = await prisma.$transaction([
      prisma.inventoryItem.update({
        where: { id: item.id },
        data: {
          totalSoldInt: { increment: qty },
          quantityBalance: { decrement: qty },
        },
      }),
      prisma.inventoryTransaction.create({
        data: {
          itemId: item.id,
          type: 'SALE',
          quantity: qty,
          unitPrice: price,
          totalAmount,
          referenceNo: referenceNo || `SALE-${Date.now()}`,
          issuedTo: issuedTo || null,
          notes: notes || null,
        },
      }),
    ]);

    return res.json({
      success: true,
      message: `Successfully sold/issued ${qty} ${item.unit} of ${item.name}.`,
      item: updatedItem,
      transaction,
    });
  } catch (error: any) {
    console.error('[INVENTORY] Sale error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to record stock sale.' });
  }
}

/**
 * DELETE /api/admin/inventory/items/:id
 */
export async function deleteInventoryItem(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const id = parseInt(req.params.id as string, 10);
    const item = await prisma.inventoryItem.findFirst({
      where: { id, branchId },
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    }

    await prisma.inventoryItem.delete({
      where: { id: item.id },
    });

    return res.json({
      success: true,
      message: `Item "${item.name}" and its stock records deleted.`,
    });
  } catch (error) {
    console.error('[INVENTORY] Delete error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete inventory item.' });
  }
}

// ============================================================================
// MYEDURIDE INTEGRATION & TRANSPORT
// ============================================================================

/**
 * GET /api/admin/myeduride/config
 */
export async function getMyEduRideConfigHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const config = await getMyEduRideConfig(prisma, branchId!);
    return res.json({ success: true, data: config });
  } catch (err) {
    console.error('[MYEDURIDE] GET config error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load MyEduRide configuration.' });
  }
}

/**
 * POST /api/admin/myeduride/config
 */
export async function saveMyEduRideConfigHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const updated = await saveMyEduRideConfig(prisma, branchId!, req.body || {});
    return res.json({
      success: true,
      message: 'MyEduRide API configuration saved successfully.',
      data: updated,
    });
  } catch (err) {
    console.error('[MYEDURIDE] POST config error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save MyEduRide configuration.' });
  }
}

/**
 * POST /api/admin/myeduride/test-connection
 */
export async function testMyEduRideConnectionHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const currentConfig = await getMyEduRideConfig(prisma, branchId!);
    const { apiUrl = currentConfig.apiUrl, apiKey = currentConfig.apiKey } = req.body || {};

    const testResult = await testMyEduRideConnection({
      apiUrl,
      apiKey,
      branchCode: currentConfig.branchCode,
    });

    return res.json({
      success: true,
      data: testResult,
    });
  } catch (err) {
    console.error('[MYEDURIDE] Connection test error:', err);
    return res.status(500).json({ success: false, message: 'Failed to test MyEduRide connection.' });
  }
}

/**
 * POST /api/admin/myeduride/sync-roster
 */
export async function syncRosterHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const result = await syncStudentsToMyEduRide(prisma, branchId!);
    return res.json(result);
  } catch (err) {
    console.error('[MYEDURIDE] Roster sync error:', err);
    return res.status(500).json({ success: false, message: 'Failed to synchronize roster to MyEduRide.' });
  }
}

/**
 * GET /api/admin/myeduride/overview
 */
export async function getMyEduRideOverview(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const overview = await getTransportOverview(prisma, branchId!);
    return res.json({ success: true, data: overview });
  } catch (err) {
    console.error('[MYEDURIDE] Overview error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load MyEduRide overview.' });
  }
}

/**
 * GET /api/admin/myeduride/buses
 */
export async function getMyEduRideBuses(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const fleet = await getBusFleet(prisma, branchId!);
    return res.json({ success: true, data: fleet });
  } catch (err) {
    console.error('[MYEDURIDE] Bus fleet error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load bus fleet.' });
  }
}

/**
 * GET /api/admin/myeduride/gate-logs
 */
export async function getGateLogsHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { role, status, direction, search, limit } = (req.query || {}) as any;
    const logs = await getGateLogs(prisma, branchId!, {
      role,
      status,
      direction,
      search,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });
    return res.json({ success: true, data: logs });
  } catch (err) {
    console.error('[MYEDURIDE] Gate logs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load gate access logs.' });
  }
}

/**
 * POST /api/admin/myeduride/gate-logs/scan
 */
export async function scanGateLogHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const {
    code,
    direction = 'ENTRY',
    gateLocation = 'Main Front Turnstile Gate 1',
    verifiedBy = 'Turnstile Scanner',
  } = req.body || {};

  if (!code) {
    return res.status(400).json({ success: false, message: 'Scan code is required.' });
  }

  try {
    const result = await processGateScan(prisma, branchId!, {
      code,
      direction,
      gateLocation,
      verifiedBy,
    });
    return res.json(result);
  } catch (err) {
    console.error('[MYEDURIDE] Gate scan error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process gate scan.' });
  }
}

/**
 * POST /api/admin/myeduride/manifest/board
 */
export async function boardManifestHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;
  const { studentId, busId, status } = req.body || {};

  if (!studentId) {
    return res.status(400).json({ success: false, message: 'studentId is required.' });
  }

  try {
    const result = await updateStudentBoarding(prisma, branchId!, {
      studentId,
      busId,
      status,
    });
    return res.json(result);
  } catch (err) {
    console.error('[MYEDURIDE] Manifest boarding error:', err);
    return res.status(500).json({ success: false, message: 'Failed to record student boarding.' });
  }
}

/**
 * GET /api/admin/myeduride/export/csv
 */
export async function exportGateLogsCsvHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true },
    });
    const logs = await getGateLogs(prisma, branchId!, { limit: 500 });
    const csv = exportGateLogsCsv(logs, branch?.name || 'Ugbekun Schools');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="myeduride_gate_access_log.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('[MYEDURIDE] CSV export error:', err);
    return res.status(500).json({ success: false, message: 'Failed to export gate logs CSV.' });
  }
}

/**
 * GET /api/admin/myeduride/export/pdf
 */
export async function exportGateLogsPdfHandler(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true },
    });
    const logs = await getGateLogs(prisma, branchId!, { limit: 150 });
    const pdfBuffer = await exportGateLogsPdf(logs, branch?.name || 'Ugbekun International Academy');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="myeduride_gate_access_log.pdf"');
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[MYEDURIDE] PDF export error:', err);
    return res.status(500).json({ success: false, message: 'Failed to export gate logs PDF.' });
  }
}

// ============================================================================
// LANDING PAGE CMS
// ============================================================================

/**
 * GET /api/admin/landing-page
 */
export async function getLandingPageConfig(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { landingPage: true, systemSetting: true },
    });

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    const landingPage = branch.landingPage || (await getOrCreateLandingPage(prisma, branch.id));
    const formatted = formatLandingPageResponse(branch, landingPage, branch.systemSetting);

    return res.json(formatted);
  } catch (error: any) {
    console.error('[ADMIN] Fetch landing page error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load landing page.' });
  }
}

/**
 * PUT /api/admin/landing-page
 */
export async function updateLandingPageConfig(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const {
      isEnabled,
      heroHeadline,
      heroSubheadline,
      heroBanners,
      welcomeTitle,
      welcomeMessage,
      welcomeAuthor,
      welcomePhoto,
      aboutText,
      photoGallery,
      academicPrograms,
      announcements,
      primaryColor,
      secondaryColor,
      showAdmissionCta,
      showPortalLoginCta,
      showGallery,
      showAnnouncements,
      facebookUrl,
      instagramUrl,
      youtubeUrl,
      twitterUrl,
    } = req.body;

    const updatedLandingPage = await prisma.schoolLandingPage.upsert({
      where: { branchId },
      update: {
        ...(isEnabled !== undefined && { isEnabled: Boolean(isEnabled) }),
        ...(heroHeadline !== undefined && { heroHeadline: String(heroHeadline).trim() }),
        ...(heroSubheadline !== undefined && { heroSubheadline: String(heroSubheadline).trim() }),
        ...(heroBanners !== undefined && { heroBanners }),
        ...(welcomeTitle !== undefined && { welcomeTitle }),
        ...(welcomeMessage !== undefined && { welcomeMessage }),
        ...(welcomeAuthor !== undefined && { welcomeAuthor }),
        ...(welcomePhoto !== undefined && { welcomePhoto }),
        ...(aboutText !== undefined && { aboutText }),
        ...(photoGallery !== undefined && { photoGallery }),
        ...(academicPrograms !== undefined && { academicPrograms }),
        ...(announcements !== undefined && { announcements }),
        ...(primaryColor !== undefined && { primaryColor }),
        ...(secondaryColor !== undefined && { secondaryColor }),
        ...(showAdmissionCta !== undefined && { showAdmissionCta: Boolean(showAdmissionCta) }),
        ...(showPortalLoginCta !== undefined && { showPortalLoginCta: Boolean(showPortalLoginCta) }),
        ...(showGallery !== undefined && { showGallery: Boolean(showGallery) }),
        ...(showAnnouncements !== undefined && { showAnnouncements: Boolean(showAnnouncements) }),
        ...(facebookUrl !== undefined && { facebookUrl }),
        ...(instagramUrl !== undefined && { instagramUrl }),
        ...(youtubeUrl !== undefined && { youtubeUrl }),
        ...(twitterUrl !== undefined && { twitterUrl }),
      },
      create: {
        branchId: branchId!,
        isEnabled: isEnabled !== undefined ? Boolean(isEnabled) : true,
        heroHeadline: heroHeadline || 'Nurturing Future Leaders & Scholars',
        heroSubheadline,
        heroBanners,
        welcomeTitle: welcomeTitle || 'Welcome from the Principal',
        welcomeMessage,
        welcomeAuthor,
        welcomePhoto,
        aboutText,
        photoGallery,
        academicPrograms,
        announcements,
        primaryColor: primaryColor || '#003da5',
        secondaryColor: secondaryColor || '#009ca6',
        showAdmissionCta: showAdmissionCta !== undefined ? Boolean(showAdmissionCta) : true,
        showPortalLoginCta: showPortalLoginCta !== undefined ? Boolean(showPortalLoginCta) : true,
        showGallery: showGallery !== undefined ? Boolean(showGallery) : true,
        showAnnouncements: showAnnouncements !== undefined ? Boolean(showAnnouncements) : true,
        facebookUrl,
        instagramUrl,
        youtubeUrl,
        twitterUrl,
      },
    });

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true },
    });

    const formatted = formatLandingPageResponse(branch, updatedLandingPage, branch?.systemSetting);
    return res.json({
      success: true,
      message: 'Landing page updated successfully.',
      data: formatted,
    });
  } catch (error: any) {
    console.error('[ADMIN] Update landing page error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update landing page.' });
  }
}

// ============================================================================
// CUSTOM DOMAIN MANAGEMENT
// ============================================================================

/**
 * GET /api/admin/domain/config
 */
export async function getDomainConfig(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    let branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        name: true,
        code: true,
        subdomain: true,
        customDomain: true,
        domainStatus: true,
        domainVerificationToken: true,
        domainDnsTarget: true,
        sslStatus: true,
        domainVerifiedAt: true,
      },
    });

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }

    if (!branch.domainVerificationToken) {
      const token = generateDomainVerificationToken(branch.id);
      branch = await prisma.branch.update({
        where: { id: branch.id },
        data: { domainVerificationToken: token },
        select: {
          id: true,
          name: true,
          code: true,
          subdomain: true,
          customDomain: true,
          domainStatus: true,
          domainVerificationToken: true,
          domainDnsTarget: true,
          sslStatus: true,
          domainVerifiedAt: true,
        },
      });
    }

    const defaultSlug = branch.subdomain || branch.code?.toLowerCase() || `branch-${branch.id}`;

    return res.json({
      success: true,
      data: {
        branchId: branch.id,
        branchName: branch.name,
        branchCode: branch.code,
        subdomain: defaultSlug,
        subdomainUrl: `https://${defaultSlug}.ugbekun.edu.ng`,
        customDomain: branch.customDomain,
        customDomainUrl: branch.customDomain ? `https://${branch.customDomain}` : null,
        domainStatus: branch.domainStatus || 'PENDING_VERIFICATION',
        verificationToken: branch.domainVerificationToken,
        dnsTarget: branch.domainDnsTarget || DEFAULT_DNS_TARGET,
        sslStatus: branch.sslStatus || 'PENDING',
        domainVerifiedAt: branch.domainVerifiedAt,
        dnsInstructions: {
          cname: {
            type: 'CNAME',
            host: branch.customDomain
              ? branch.customDomain.includes('.')
                ? branch.customDomain.split('.')[0]
                : '@'
              : 'portal',
            target: branch.domainDnsTarget || DEFAULT_DNS_TARGET,
            ttl: '300 (Auto)',
          },
          txt: {
            type: 'TXT',
            host: '_ugbekun-challenge',
            value: `ugbekun-verification=${branch.domainVerificationToken}`,
            ttl: '300 (Auto)',
          },
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Domain config error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load domain config.' });
  }
}

/**
 * POST /api/admin/domain/update
 */
export async function updateDomain(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const { subdomain, customDomain } = req.body;

    const updateData: any = {};
    if (subdomain !== undefined) {
      const formattedSlug = formatDomainSlug(subdomain);
      if (formattedSlug) {
        const existing = await prisma.branch.findFirst({
          where: { subdomain: formattedSlug, NOT: { id: branchId } },
        });
        if (existing) {
          return res.status(400).json({ success: false, message: `Subdomain "${formattedSlug}" is already taken.` });
        }
        updateData.subdomain = formattedSlug;
      }
    }

    if (customDomain !== undefined) {
      if (customDomain) {
        const clean = String(customDomain)
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/$/, '');
        const existing = await prisma.branch.findFirst({
          where: { customDomain: clean, NOT: { id: branchId } },
        });
        if (existing) {
          return res
            .status(400)
            .json({ success: false, message: `Domain "${clean}" is already registered by another branch.` });
        }
        updateData.customDomain = clean;
        updateData.domainStatus = 'PENDING_VERIFICATION';
        updateData.sslStatus = 'PENDING';
      } else {
        updateData.customDomain = null;
        updateData.domainStatus = 'ACTIVE';
      }
    }

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: updateData,
      select: {
        id: true,
        subdomain: true,
        customDomain: true,
        domainStatus: true,
        sslStatus: true,
      },
    });

    return res.json({
      success: true,
      message: 'Domain configuration updated successfully.',
      data: updated,
    });
  } catch (error: any) {
    console.error('[ADMIN] Update domain error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update domain.' });
  }
}

/**
 * POST /api/admin/domain/verify-dns
 */
export async function verifyDns(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
    });

    if (!branch || !branch.customDomain) {
      return res.status(400).json({ success: false, message: 'No custom domain configured for verification.' });
    }

    const token = branch.domainVerificationToken || generateDomainVerificationToken(branch.id);
    const target = branch.domainDnsTarget || DEFAULT_DNS_TARGET;

    const probe = await verifyDomainDns(branch.customDomain, token, target);

    if (probe.verified) {
      await prisma.branch.update({
        where: { id: branch.id },
        data: {
          domainStatus: 'ACTIVE',
          sslStatus: 'ACTIVE',
          domainVerifiedAt: new Date(),
        },
      });
    } else {
      await prisma.branch.update({
        where: { id: branch.id },
        data: { domainStatus: 'MISCONFIGURED' },
      });
    }

    return res.json({
      success: true,
      data: {
        branchId: branch.id,
        customDomain: branch.customDomain,
        ...probe,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN] Verify DNS error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to verify DNS.' });
  }
}

/**
 * DELETE /api/admin/domain/remove
 */
export async function removeDomain(req: Request, res: Response): Promise<Response | void> {
  const branchId = req.branchId;

  try {
    await prisma.branch.update({
      where: { id: branchId },
      data: {
        customDomain: null,
        domainStatus: 'ACTIVE',
        sslStatus: 'PENDING',
      },
    });

    return res.json({
      success: true,
      message: 'Custom domain removed successfully.',
    });
  } catch (error: any) {
    console.error('[ADMIN] Remove domain error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to remove domain.' });
  }
}
