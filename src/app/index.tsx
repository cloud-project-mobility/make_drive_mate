import { Redirect } from 'expo-router';
import { useApp } from '../state/AppProvider';
export default function Index() {
  const { state } = useApp();
  return <Redirect href={state.onboarded ? '/(tabs)' : '/welcome'} />;
}
