// Static AWS keys are for local development only. On AWS the task's IAM role supplies credentials, so the S3 client must then be
// built WITHOUT a `credentials` option: passing { accessKeyId: undefined } makes the SDK throw instead of using the role.
// A lone key (half a pair) is ignored rather than passed on, because a broken pair would fail every upload.
function awsClientCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {};
}

module.exports = { awsClientCredentials };
