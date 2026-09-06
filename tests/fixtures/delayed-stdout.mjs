// The natural race depends on the Node version, operating system, and pipe
// scheduling, so it does not reproduce on every supported setup. Delay the
// write so a forced exit loses the text on every platform, independent of
// pipe size or scheduling luck.
const write = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk, encoding, callback) => {
  setTimeout(() => write(chunk, encoding, callback), 25);
  return false;
};
