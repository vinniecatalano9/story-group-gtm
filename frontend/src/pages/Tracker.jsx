const BUILD_STAMP = Date.now();

export default function Tracker() {
  return (
    <div className="-mx-6 -my-6" style={{ height: 'calc(100vh - 60px)' }}>
      <iframe
        src={`/tracker/index.html?v=${BUILD_STAMP}`}
        title="Story Group Daily Tracker"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    </div>
  );
}
