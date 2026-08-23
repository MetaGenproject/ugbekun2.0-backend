/**
 * Service for managing School Public Landing Pages (Front-CMS)
 */

export interface HeroBannerSlide {
  id: number | string;
  url: string;
  caption: string;
  subcaption?: string;
  ctaText?: string;
  ctaLink?: string;
}

export interface AcademicProgramItem {
  id: string;
  title: string;
  ageGroup: string;
  icon?: string;
  description: string;
}

export interface GalleryPhotoItem {
  id: number | string;
  url: string;
  caption: string;
  category?: string;
}

export interface AnnouncementItem {
  id: number | string;
  title: string;
  date: string;
  badge: string;
  excerpt: string;
  link: string;
}

export function getDefaultBanners(schoolName: string): HeroBannerSlide[] {
  return [
    {
      id: 1,
      url: 'https://images.unsplash.com/photo-1580582932707-520aed937b7b?auto=format&fit=crop&w=1600&q=80',
      caption: `Welcome to ${schoolName} — Shaping Tomorrows Leaders Today`,
      subcaption: 'World-class academic standards, moral integrity, and technological excellence.',
      ctaText: 'Apply for Admission',
      ctaLink: '/subscribe'
    },
    {
      id: 2,
      url: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1600&q=80',
      caption: 'Innovative STEM & Digital Learning Environment',
      subcaption: 'State-of-the-art laboratories, robotic studios, and digital smart classrooms.',
      ctaText: 'Explore Academics',
      ctaLink: '#academics'
    },
    {
      id: 3,
      url: 'https://images.unsplash.com/photo-1577896851231-70ef18881754?auto=format&fit=crop&w=1600&q=80',
      caption: 'Holistic Development & Sports Excellence',
      subcaption: 'Developing well-rounded students with vibrant arts, athletics, and leadership clubs.',
      ctaText: 'Campus Life',
      ctaLink: '#gallery'
    }
  ];
}

export function getDefaultAcademicPrograms(): AcademicProgramItem[] {
  return [
    {
      id: 'early-years',
      title: 'Early Years & Nursery',
      ageGroup: 'Ages 2 - 5 Years',
      icon: 'Baby',
      description: 'Montessori-grounded foundational learning cultivating curiosity, phonics, numeracy, and social-emotional growth in a nurturing setting.'
    },
    {
      id: 'primary',
      title: 'Basic / Primary Education',
      ageGroup: 'Ages 6 - 11 Years',
      icon: 'BookOpen',
      description: 'Comprehensive curriculum spanning STEM, literacy, creative arts, and ICT with personalized learning milestones.'
    },
    {
      id: 'junior-secondary',
      title: 'Junior Secondary (JSS 1 - 3)',
      ageGroup: 'Ages 11 - 14 Years',
      icon: 'GraduationCap',
      description: 'Rigorous preparatory education for BECE/NECO with practical science laboratories, coding, and foreign language immersion.'
    },
    {
      id: 'senior-secondary',
      title: 'Senior Secondary (SSS 1 - 3)',
      ageGroup: 'Ages 14 - 17 Years',
      icon: 'Award',
      description: 'Specialized Science, Arts, and Commercial tracks preparing scholars for WAEC, JAMB/UTME, SAT, and Cambridge IGCSE with distinction.'
    }
  ];
}

export function getDefaultGallery(): GalleryPhotoItem[] {
  return [
    {
      id: 1,
      url: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=800&q=80',
      caption: 'Modern Science & Chemistry Laboratory',
      category: 'Laboratories'
    },
    {
      id: 2,
      url: 'https://images.unsplash.com/photo-1580582932707-520aed937b7b?auto=format&fit=crop&w=800&q=80',
      caption: 'Main Academic Campus & Courtyard',
      category: 'Campus'
    },
    {
      id: 3,
      url: 'https://images.unsplash.com/photo-1577896851231-70ef18881754?auto=format&fit=crop&w=800&q=80',
      caption: 'ICT, Coding & Artificial Intelligence Hub',
      category: 'Technology'
    },
    {
      id: 4,
      url: 'https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=800&q=80',
      caption: 'Annual Inter-House Sports & Track Athletics',
      category: 'Sports'
    },
    {
      id: 5,
      url: 'https://images.unsplash.com/photo-1544717305-2782549b5136?auto=format&fit=crop&w=800&q=80',
      caption: 'Music Orchestra & Creative Arts Studio',
      category: 'Arts'
    },
    {
      id: 6,
      url: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&w=800&q=80',
      caption: 'Ultra-Modern Digital Library & Research Center',
      category: 'Library'
    }
  ];
}

export function getDefaultAnnouncements(): AnnouncementItem[] {
  return [
    {
      id: 1,
      title: 'Admissions Open for the 2026/2027 Academic Session',
      date: 'Aug 2026',
      badge: 'Admissions',
      excerpt: 'Entrance examinations and scholarship assessments are currently ongoing. Register your ward online today.',
      link: '/subscribe'
    },
    {
      id: 2,
      title: 'First Term Resumption & Orientation Week',
      date: 'Sep 2026',
      badge: 'Academic Calendar',
      excerpt: 'All boarders and day scholars are expected on campus for the new academic year orientation and handbook distribution.',
      link: '#contact'
    },
    {
      id: 3,
      title: 'Outstanding Performance in National STEM & Robotics Olympiad',
      date: 'Jul 2026',
      badge: 'Achievement',
      excerpt: 'Our junior and senior robotics teams emerged 1st overall in the State Robotics & Coding Championship.',
      link: '#gallery'
    }
  ];
}

/**
 * Gets or creates the default Landing Page for a school branch
 */
export async function getOrCreateLandingPage(prisma: any, branchId: number) {
  let landingPage = await prisma.schoolLandingPage.findUnique({
    where: { branchId }
  });

  if (!landingPage) {
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { systemSetting: true }
    });

    const schoolName = branch?.systemSetting?.schoolName || branch?.name || 'Our School Academy';

    landingPage = await prisma.schoolLandingPage.create({
      data: {
        branchId,
        isEnabled: true,
        heroHeadline: `Excellence in Knowledge, Character & Innovation`,
        heroSubheadline: `Welcome to ${schoolName}. We empower young minds with world-class academics, strong moral ethics, and 21st-century digital competencies.`,
        heroBanners: getDefaultBanners(schoolName),
        welcomeTitle: 'A Message from the Principal',
        welcomeMessage: `On behalf of our dedicated faculty and staff, I warmly welcome you to ${schoolName}. Our mission is to inspire, nurture, and prepare every student for global relevance and lifelong success.`,
        welcomeAuthor: 'Executive Principal / Head of School',
        welcomePhoto: 'https://images.unsplash.com/photo-1544717302-de2939b7ef71?auto=format&fit=crop&w=400&q=80',
        aboutText: `${schoolName} is a premier educational institution fostering excellence through modern STEM labs, leadership curricula, and moral guidance.`,
        photoGallery: getDefaultGallery(),
        academicPrograms: getDefaultAcademicPrograms(),
        announcements: getDefaultAnnouncements(),
        primaryColor: '#003da5',
        secondaryColor: '#009ca6',
        showAdmissionCta: true,
        showPortalLoginCta: true,
        showGallery: true,
        showAnnouncements: true,
        socials: {
          facebook: 'https://facebook.com',
          instagram: 'https://instagram.com',
          youtube: 'https://youtube.com',
          twitter: 'https://twitter.com'
        }
      }
    });
  }

  return landingPage;
}

/**
 * Serializes formatted landing page payload with branch metadata
 */
export function formatLandingPageResponse(branch: any, landingPage: any, customSettings?: any) {
  const settings = customSettings || branch?.systemSetting || {};
  const schoolName = settings.schoolName || branch.name || 'Ugbekun Partner School';
  const logo = settings.logoUrl || null;
  const primaryColor = landingPage.primaryColor || settings.primaryColor || '#003da5';
  const secondaryColor = landingPage.secondaryColor || settings.secondaryColor || '#009ca6';

  return {
    branchId: branch.id,
    branchCode: branch.code,
    schoolName,
    tagline: settings.tagline || 'Excellence in Holistic Education',
    logoUrl: logo,
    primaryColor,
    secondaryColor,
    subdomain: branch.subdomain,
    customDomain: branch.customDomain,
    domainStatus: branch.domainStatus || 'ACTIVE',
    isEnabled: landingPage.isEnabled ?? true,
    heroHeadline: landingPage.heroHeadline,
    heroSubheadline: landingPage.heroSubheadline,
    heroBanners: landingPage.heroBanners || [],
    welcomeTitle: landingPage.welcomeTitle,
    welcomeMessage: landingPage.welcomeMessage,
    welcomeAuthor: landingPage.welcomeAuthor,
    welcomePhoto: landingPage.welcomePhoto,
    aboutText: landingPage.aboutText,
    photoGallery: landingPage.photoGallery || [],
    academicPrograms: landingPage.academicPrograms || [],
    announcements: landingPage.announcements || [],
    showAdmissionCta: landingPage.showAdmissionCta ?? true,
    showPortalLoginCta: landingPage.showPortalLoginCta ?? true,
    showGallery: landingPage.showGallery ?? true,
    showAnnouncements: landingPage.showAnnouncements ?? true,
    socials: landingPage.socials || {},
    contact: {
      address: settings.address || 'Campus Education Boulevard',
      email: settings.email || 'admissions@school.edu.ng',
      phone: settings.phone || '+234 800 UGBEKUN'
    }
  };
}

module.exports = {
  getDefaultBanners,
  getDefaultAcademicPrograms,
  getDefaultGallery,
  getDefaultAnnouncements,
  getOrCreateLandingPage,
  formatLandingPageResponse
};
