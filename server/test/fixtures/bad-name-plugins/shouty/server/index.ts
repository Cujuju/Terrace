// Discovery fixture: an illegal plugin name (uppercase + a namespace
// separator). Must abort discovery — the name is a wire namespace.
export const plugin = {
  name: 'Shouty:Name',
};
