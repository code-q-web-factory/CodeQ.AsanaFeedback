import manifest from '@neos-project/neos-ui-extensibility';
import FeedbackButton from './FeedbackButton';

manifest('CodeQ.AsanaFeedback:Plugin', {}, (globalRegistry) => {
    // right of the content dimension switcher, before the user dropdown
    globalRegistry.get('containers').set(
        'PrimaryToolbar/Right/AsanaFeedbackButton',
        FeedbackButton,
        'before PrimaryToolbar/Right/UserDropDown'
    );
});
