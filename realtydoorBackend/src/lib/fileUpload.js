const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const { randomUUID } = require('crypto');
const path = require('path');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET;
const REGION = process.env.AWS_REGION;

const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];
const DOC_FORMATS   = ['jpg', 'jpeg', 'png', 'pdf'];
const VIDEO_FORMATS = ['mp4', 'mov', 'webm', 'avi'];
const MEDIA_FORMATS = [...new Set([...IMAGE_FORMATS, ...VIDEO_FORMATS])];
const ALL_FORMATS   = [...new Set([...IMAGE_FORMATS, ...DOC_FORMATS])];
const ApiError = require('../utils/ApiError');

// ─── Core helpers ─────────────────────────────────────────────────────────────

function buildMulter(allowedFormats, maxSizeMb = 10) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = file.originalname.split('.').pop().toLowerCase();
      if (allowedFormats.includes(ext)) {
        cb(null, true);
      } else {
        cb(new ApiError(400, `File type .${ext} not allowed. Accepted: ${allowedFormats.join(', ')}`));
      }
    },
  });
}

// The upload filter only checks the file extension, and the client chooses the mimetype. Storing that mimetype as the
// object's ContentType would let "x.png" sent as text/html be served from the bucket as a web page. Serve each file
// as the type its (allow-listed) extension says it is, whatever the client claimed.
const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
};

// The extension is chosen by the sender, so a script or web page can be sent as "photo.png". Images and PDFs must start with the
// bytes that format starts with. (Videos are left to the allow-listed extension and the forced content type below.)
const SIGNATURES = {
  '.jpg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.pdf': (b) => b.subarray(0, 1024).includes('%PDF-', 0, 'latin1'),
};

function assertFileMatchesExtension(buffer, ext) {
  const check = SIGNATURES[ext];
  if (!check) return;
  if (!Buffer.isBuffer(buffer) || !check(buffer)) {
    throw new ApiError(400, `This file is not a valid ${ext.slice(1).toUpperCase()}. Upload the original file.`, { code: 'FILE_CONTENT_MISMATCH' });
  }
}

async function s3Upload(buffer, folder, originalname, mimetype) {
  const ext = path.extname(originalname).toLowerCase();
  assertFileMatchesExtension(buffer, ext);
  const key = `${folder}/${randomUUID()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream',
  }));

  return {
    url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`,
    key,
  };
}

async function uploadAllFiles(req, folder) {
  if (req.file) {
    const { url, key } = await s3Upload(req.file.buffer, folder, req.file.originalname, req.file.mimetype);
    req.file.path  = url;
    req.file.s3Key = key;
  }

  if (Array.isArray(req.files)) {
    for (const file of req.files) {
      const { url, key } = await s3Upload(file.buffer, folder, file.originalname, file.mimetype);
      file.path  = url;
      file.s3Key = key;
    }
  }

  if (req.files && !Array.isArray(req.files)) {
    for (const fieldFiles of Object.values(req.files)) {
      for (const file of fieldFiles) {
        const { url, key } = await s3Upload(file.buffer, folder, file.originalname, file.mimetype);
        file.path  = url;
        file.s3Key = key;
      }
    }
  }
}

// ─── Uploader factory ─────────────────────────────────────────────────────────
// Returns an object with .single() / .array() / .fields() — same API as multer.
// Multer runs first (memoryStorage), then each buffer is uploaded to S3.
// Existing routes that call  uploader.single('file')  or  uploader.fields([...])
// continue to work without any changes.

function buildUploader(folder, allowedFormats, maxSizeMb = 10) {
  const upload = buildMulter(allowedFormats, maxSizeMb);

  const withS3 = (multerMiddleware) => (req, res, next) => {
    multerMiddleware(req, res, async (err) => {
      // B17 — multer/filter errors are the client's mistake, not a server fault.
      if (err) return next(err.name === 'MulterError' ? new ApiError(400, err.message) : err);
      try {
        await uploadAllFiles(req, folder);
        next();
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  };

  return {
    single: (field)        => withS3(upload.single(field)),
    array:  (field, max)   => withS3(upload.array(field, max)),
    fields: (fields)       => withS3(upload.fields(fields)),
  };
}

// ─── Pre-configured uploaders (same names as before) ─────────────────────────

const propertyImageUploader  = buildUploader('properties', IMAGE_FORMATS);
const propertyVideoUploader  = buildUploader('properties', VIDEO_FORMATS, 200); // 200 MB for videos
const propertyMediaUploader  = buildUploader('properties', MEDIA_FORMATS, 200); // images + videos
const propertyDocUploader    = buildUploader('properties/documents', DOC_FORMATS);
const kycDocUploader         = buildUploader('kyc',        DOC_FORMATS);
const visitPhotoUploader     = buildUploader('visits',     IMAGE_FORMATS);
// B17 — allocation letter / token receipt / closure docs are signed PDFs as often as photos.
const dealDocUploader        = buildUploader('visits',     DOC_FORMATS);
const userDocUploader        = buildUploader('documents',  DOC_FORMATS);
const ticketEvidenceUploader = buildUploader('tickets',    ALL_FORMATS);
const cmsMediaUploader       = buildUploader('admin-cms',  MEDIA_FORMATS);
const videoTourUploader      = buildUploader('video-tours', VIDEO_FORMATS, 500); // 500 MB
const partnerProfilePhotoUploader = buildUploader('partners/profile-photos', IMAGE_FORMATS);
// Money model phase 2 — a GST-registered partner's tax invoice for a deal.
const taxInvoiceUploader = buildUploader('partners/tax-invoices', DOC_FORMATS);

async function deleteFile(s3Key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key }));
}

module.exports = {
  propertyImageUploader,
  propertyVideoUploader,
  propertyMediaUploader,
  propertyDocUploader,
  kycDocUploader,
  visitPhotoUploader,
  dealDocUploader,
  userDocUploader,
  ticketEvidenceUploader,
  cmsMediaUploader,
  videoTourUploader,
  partnerProfilePhotoUploader,
  taxInvoiceUploader,
  deleteFile,
  s3Upload,
  assertFileMatchesExtension,
  buildMulter,
  IMAGE_FORMATS,
};
