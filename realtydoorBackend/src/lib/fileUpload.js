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
        cb(new Error(`File type .${ext} not allowed. Accepted: ${allowedFormats.join(', ')}`));
      }
    },
  });
}

async function s3Upload(buffer, folder, originalname, mimetype) {
  const ext = path.extname(originalname).toLowerCase();
  const key = `${folder}/${randomUUID()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype,
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
      if (err) return next(err);
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
const userDocUploader        = buildUploader('documents',  DOC_FORMATS);
const ticketEvidenceUploader = buildUploader('tickets',    ALL_FORMATS);
const cmsMediaUploader       = buildUploader('admin-cms',  MEDIA_FORMATS);
const videoTourUploader      = buildUploader('video-tours', VIDEO_FORMATS, 500); // 500 MB

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
  userDocUploader,
  ticketEvidenceUploader,
  cmsMediaUploader,
  videoTourUploader,
  deleteFile,
};
